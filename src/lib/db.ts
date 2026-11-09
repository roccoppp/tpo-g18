import { MongoClient } from "mongodb";
import neo4j, { type Driver } from "neo4j-driver";

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

export async function connectNeo4j(): Promise<Driver> {
  const driver = neo4j.driver(
    requiredEnv("NEO4J_URI"),
    neo4j.auth.basic(requiredEnv("NEO4J_USER"), requiredEnv("NEO4J_PASSWORD")),
    // Los enteros del grafo (unidades, precios) caben en un number de JS: se leen como number y
    // no como el Integer de 64 bits del driver.
    { disableLosslessIntegers: true },
  );
  try {
    await driver.verifyConnectivity();
  } catch (error) {
    await driver.close();
    throw error;
  }
  return driver;
}
