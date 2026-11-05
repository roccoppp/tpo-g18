// Ejecuta una consulta e imprime el resultado como JSON.
// Uso: npm run query -- <número> [parámetros...]   (ej. npm run query -- 1)

import { connectMongo, connectRedis } from "../src/lib/db.js";
import { crearRepositorios, type Repositorios } from "../src/lib/repositorios.js";
import { q01ProductosActivosConProveedor } from "../src/queries/q01.js";

type Consulta = (repos: Repositorios, args: string[]) => Promise<unknown>;

const consultas: Record<number, Consulta> = {
  1: ({ productos, proveedores }) => q01ProductosActivosConProveedor(productos, proveedores),
};

const [numero, ...args] = process.argv.slice(2);
const consulta = consultas[Number(numero?.replace(/^q/i, ""))];
if (!consulta) {
  console.error(`Uso: npm run query -- <número>. Disponibles: ${Object.keys(consultas).join(", ")}`);
  process.exit(1);
}

const mongo = await connectMongo();
const redis = await connectRedis();

try {
  const resultado = await consulta(crearRepositorios(mongo.db(), redis), args);
  console.log(JSON.stringify(resultado, null, 2));
} finally {
  await redis.close();
  await mongo.close();
}
