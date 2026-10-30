
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseSecretKey) {
    throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SECRET_KEY environment variable",
    );
}

export const supabaseStorage = createClient(
    supabaseUrl,
    supabaseSecretKey,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
        },
    },
);

export const KNOWLEDGE_BANK_BUCKET = "knowledge-bank";
