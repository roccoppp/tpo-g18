import type { Driver, ManagedTransaction } from "neo4j-driver";

/** Ejecuta `trabajo` en una única transacción de escritura de Neo4j: se aplica todo o nada. */
export async function enTransaccion<T>(
  driver: Driver,
  trabajo: (tx: ManagedTransaction) => Promise<T>,
): Promise<T> {
  const session = driver.session();
  try {
    return await session.executeWrite(trabajo);
  } finally {
    await session.close();
  }
}

/**
 * Crea, si no existe, la restricción de unicidad sobre el id de una etiqueta. Neo4j la respalda
 * con un índice, que es el que usan los MERGE y MATCH por id.
 */
export async function asegurarIdUnico(driver: Driver, etiqueta: string, propiedad: string): Promise<void> {
  await driver.executeQuery(
    `CREATE CONSTRAINT ${etiqueta.toLowerCase()}_${propiedad} IF NOT EXISTS
     FOR (n:${etiqueta}) REQUIRE n.${propiedad} IS UNIQUE`,
  );
}
