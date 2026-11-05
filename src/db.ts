import { MongoClient } from "mongodb";
import { createClient } from "redis";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta ${name}. Ejecutá el proyecto dentro del Codespace.`);
  }
  return value;
}

export async function connectMongo(): Promise<MongoClient> {
  return MongoClient.connect(requiredEnv("MONGODB_URI"), {
    serverSelectionTimeoutMS: 5_000,
  });
}

export async function connectRedis() {
  const client = createClient({ url: requiredEnv("REDIS_URL") });
  client.on("error", (error) => console.error("Error de Redis:", error));
  await client.connect();
  return client;
}
