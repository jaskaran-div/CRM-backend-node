
import { Router } from "express";
import { asc, eq, and } from "drizzle-orm";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { AppContext } from "../context.js";
import { knowledgeBankItems } from "../db/schema.js";
import {
    supabaseStorage,
    KNOWLEDGE_BANK_BUCKET,
} from "../lib/supabase-storage.js";

export function knowledgeBankRoutes(ctx: AppContext) {

    const MAX_KNOWLEDGE_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

    const allowedMimeTypes = new Set([
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]);

    const uploadKnowledgeFile = multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: MAX_KNOWLEDGE_FILE_SIZE,
            files: 1,
        },
        fileFilter: (_req, file, callback) => {
            const extension = extname(file.originalname).toLowerCase();

            const allowedExtensions = [".pdf", ".doc", ".docx"];

            if (
                !allowedExtensions.includes(extension) ||
                !allowedMimeTypes.has(file.mimetype)
            ) {
                callback(
                    new Error("Only PDF, DOC and DOCX files are allowed.")
                );
                return;
            }

            callback(null, true);
        },
    });
    const router = Router();
    const { db } = ctx;

    // List only the logged-in agent's materials.
    router.get("/api/knowledge-bank", async (req, res, next) => {
        try {
            const userId = req.user!.id;

            const items = await db
                .select()
                .from(knowledgeBankItems)
                .where(eq(knowledgeBankItems.userId, userId))
                .orderBy(asc(knowledgeBankItems.title));

            res.json(items);
        } catch (error) {
            next(error);
        }
    });

    // Save a text-based material.
    router.post("/api/knowledge-bank", async (req, res, next) => {
        try {
            const userId = req.user!.id;
            const { title, category, content } = req.body ?? {};

            if (
                typeof title !== "string" ||
                !title.trim() ||
                title.trim().length > 200 ||
                typeof category !== "string" ||
                !["calling-scripts", "course-information", "brochures-documents"].includes(category) ||
                typeof content !== "string" ||
                !content.trim()
            ) {
                res.status(400).json({
                    message: "Valid title, category, and content are required.",
                });
                return;
            }

            const [item] = await db
                .insert(knowledgeBankItems)
                .values({
                    userId,
                    title: title.trim(),
                    category,
                    content: content.trim(),
                })
                .returning();

            res.status(201).json(item);
        } catch (error) {
            next(error);
        }
    });


    // Upload a PDF or Word document to the logged-in user's private storage.
    router.post(
        "/api/knowledge-bank/upload",
        uploadKnowledgeFile.single("file"),
        async (req, res, next) => {
            let uploadedFileKey: string | null = null;

            try {
                const userId = req.user!.id;
                const file = req.file;
                const { title, category } = req.body ?? {};

                if (!file) {
                    res.status(400).json({
                        message: "Please select a document to upload.",
                    });
                    return;
                }

                if (
                    typeof title !== "string" ||
                    !title.trim() ||
                    title.trim().length > 200 ||
                    typeof category !== "string" ||
                    ![
                        "calling-scripts",
                        "course-information",
                        "brochures-documents",
                    ].includes(category)
                ) {
                    res.status(400).json({
                        message: "Valid title and category are required.",
                    });
                    return;
                }

                // Verify actual file signature, not only its extension.
                const extension = extname(file.originalname).toLowerCase();

                const signatures: Record<string, Buffer> = {
                    ".pdf": Buffer.from("%PDF-"),
                    ".doc": Buffer.from("D0CF11E0A1B11AE1", "hex"),
                    ".docx": Buffer.from("504B0304", "hex"),
                };

                const signature = signatures[extension];

                if (
                    !signature ||
                    !file.buffer.subarray(0, signature.length).equals(signature)
                ) {
                    res.status(400).json({
                        message: "The uploaded file does not match its file extension.",
                    });
                    return;
                }

                // Each user gets a separate storage folder and unique filename.
                const fileKey =
                    `${userId}/${randomUUID()}${extension}`;

                const { error: uploadError } = await supabaseStorage
                    .storage
                    .from(KNOWLEDGE_BANK_BUCKET)
                    .upload(fileKey, file.buffer, {
                        contentType: file.mimetype,
                        upsert: false,
                    });

                if (uploadError) {
                    throw uploadError;
                }

                uploadedFileKey = fileKey;

                const [item] = await db
                    .insert(knowledgeBankItems)
                    .values({
                        userId,
                        title: title.trim(),
                        category,
                        content: null,
                        fileName: file.originalname,
                        fileKey,
                        fileType: file.mimetype,
                        fileSize: file.size,
                    })
                    .returning();

                uploadedFileKey = null;

                res.status(201).json(item);
            } catch (error) {
                // Avoid leaving an orphaned file if the database insert fails.
                if (uploadedFileKey) {
                    const { error: cleanupError } = await supabaseStorage
                        .storage
                        .from(KNOWLEDGE_BANK_BUCKET)
                        .remove([uploadedFileKey]);

                    if (cleanupError) {
                        console.error(
                            "Knowledge Bank storage cleanup failed:",
                            cleanupError.message
                        );
                    }
                }

                next(error);
            }
        }
    );


    // Generate a temporary viewing link for the logged-in user's own document.
    router.get("/api/knowledge-bank/:id/view", async (req, res, next) => {
        try {
            const userId = req.user!.id;
            const itemId = Number(req.params.id);

            if (!Number.isSafeInteger(itemId) || itemId <= 0) {
                res.status(400).json({ message: "Invalid material ID." });
                return;
            }

            const [item] = await db
                .select()
                .from(knowledgeBankItems)
                .where(
                    and(
                        eq(knowledgeBankItems.id, itemId),
                        eq(knowledgeBankItems.userId, userId),
                    ),
                )
                .limit(1);

            if (!item || !item.fileKey) {
                res.status(404).json({ message: "Document not found." });
                return;
            }

            const { data, error } = await supabaseStorage
                .storage
                .from(KNOWLEDGE_BANK_BUCKET)
                .createSignedUrl(item.fileKey, 60);

            if (error) {
                throw error;
            }

            res.json({
                signedUrl: data.signedUrl,
                fileName: item.fileName,
            });
        } catch (error) {
            next(error);
        }
    });


    // Delete only the logged-in agent's own material.
    router.delete("/api/knowledge-bank/:id", async (req, res, next) => {
        try {
            const userId = req.user!.id;
            const itemId = Number(req.params.id);

            if (!Number.isSafeInteger(itemId) || itemId <= 0) {
                res.status(400).json({ message: "Invalid material ID." });
                return;
            }

            const deleted = await db
                .delete(knowledgeBankItems)
                .where(
                    and(
                        eq(knowledgeBankItems.id, itemId),
                        eq(knowledgeBankItems.userId, userId),
                    ),
                )
                .returning({ id: knowledgeBankItems.id });

            if (deleted.length === 0) {
                res.status(404).json({ message: "Material not found." });
                return;
            }

            res.status(204).send();
        } catch (error) {
            next(error);
        }
    });

    return router;
}
