// Ejecuta una consulta e imprime el resultado como JSON.
// Uso: npm run query -- <número> [parámetros...]   (ej. npm run query -- 1)

import { connectMongo, connectNeo4j } from "../src/lib/db.js";
import { crearRepositorios, type Repositorios } from "../src/lib/repositorios.js";
import { q01ProductosActivosConProveedor } from "../src/queries/q01.js";
import { q08LotesConStockBajo } from "../src/queries/q08.js";

type Consulta = (repos: Repositorios, args: string[]) => Promise<unknown>;

const consultas: Record<number, Consulta> = {
  1: ({ productos }) => q01ProductosActivosConProveedor(productos),
  8: ({ lotes }) => q08LotesConStockBajo(lotes),
};

const [numero, ...args] = process.argv.slice(2);
const consulta = consultas[Number(numero?.replace(/^q/i, ""))];
if (!consulta) {
  console.error(`Uso: npm run query -- <número>. Disponibles: ${Object.keys(consultas).join(", ")}`);
  process.exit(1);
}

const mongo = await connectMongo();
const neo4j = await connectNeo4j();

try {
  const resultado = await consulta(crearRepositorios(mongo.db(), neo4j), args);
  console.log(JSON.stringify(resultado, null, 2));
} finally {
  await neo4j.close();
  await mongo.close();
}
