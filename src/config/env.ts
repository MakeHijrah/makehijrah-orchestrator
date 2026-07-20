import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum([
      "development",
      "test",
      "staging",
      "production",
    ])
    .default("development"),

  PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(3000),

  SUPABASE_URL: z.string().url(),

  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  REDIS_URL: z.string().min(1),

  OAUTH_TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          return Buffer.from(value, "base64").length === 32;
        } catch {
          return false;
        }
      },
      {
        message:
          "OAUTH_TOKEN_ENCRYPTION_KEY must be a Base64-encoded 32-byte key.",
      },
    ),

  GOOGLE_CLIENT_ID: z.string().min(1),

  GOOGLE_CLIENT_SECRET: z.string().min(1),

  GOOGLE_REDIRECT_URI: z.string().url(),

  APP_URL: z.string().url(),

  OAUTH_STATE_SECRET: z
    .string()
    .min(32),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");

  for (const issue of parsed.error.issues) {
    console.error(
      `- ${issue.path.join(".")}: ${issue.message}`,
    );
  }

  throw new Error(
    "Environment configuration is invalid",
  );
}

export const env = parsed.data;
