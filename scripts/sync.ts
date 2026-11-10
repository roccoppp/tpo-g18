// Reconstruye las copias de Neo4j a partir de MongoDB, que es la fuente de verdad. Sirve cuando una
// escritura quedó confirmada en MongoDB pero falló al actualizar su copia en el grafo. A diferencia
// de la carga, no lee los CSV ni toca MongoDB: conserva lo que escribieron los servicios.

import { connectMongo, connectNeo4j } from "../src/lib/db.js";
import { crearRepositorios } from "../src/lib/repositorios.js";

const mongo = await connectMongo();
const neo4j = await connectNeo4j();

try {
  const repos = crearRepositorios(mongo.db(), neo4j);

  // Los lotes se relacionan con los productos: los productos van antes.
  console.log(`Neo4j: ${await repos.productos.reconstruirCopia()} productos copiados desde MongoDB`);
  console.log(`Neo4j: ${await repos.lotes.reconstruirCopia()} lotes copiados desde MongoDB`);
  console.log(`Neo4j: ${await repos.clientes.reconstruirCopia()} clientes copiados desde MongoDB`);
  console.log(`Neo4j: ${await repos.ventas.reconstruirCopia()} ventas copiadas desde MongoDB`);
} finally {
  await neo4j.close();
  await mongo.close();
}
