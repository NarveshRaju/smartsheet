import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z.object({
  PORT: z.string().default(process.env.PORT || '3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SESSION_SECRET: z.string().min(16).default('development-session-secret-at-least-16-chars'),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(16).default('development-encryption-key-must-be-min-32-chars-long'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:3001/auth/google/callback'),
  SMARTSHEET_CLIENT_ID: z.string().default(''),
  SMARTSHEET_CLIENT_SECRET: z.string().default(''),
  SMARTSHEET_REDIRECT_URI: z.string().default('http://localhost:3001/auth/smartsheet/callback'),
  FRONTEND_URL: z.string().optional().default('http://localhost:5173'),
  WEBHOOK_CALLBACK_URL: z.string().optional(),
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  RENDER_EXTERNAL_URL: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  AI_PROVIDER: z.enum(['groq', 'ollama', 'none']).default('groq'),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  AI_MIN_INTERVAL_MS: z.coerce.number().int().min(1000).default(10000),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('qwen3:8b'),
  AUTO_SYNC_INTERVAL_MS: z.string().default('60000'),
});

let parsedEnv: z.infer<typeof envSchema>;
try {
  parsedEnv = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('❌ Invalid environment variables:');
    console.error(error.flatten().fieldErrors);
  }
  process.exit(1);
}

export const env = parsedEnv;

