import { connectMongo, connectRedis } from "../src/db.js";

const mongo = await connectMongo();
const redis = await connectRedis();

try {
  const db = mongo.db();
  const hello = await db.command({ hello: 1 });
  if (!hello.isWritablePrimary) {
    throw new Error("MongoDB todavía no es primario.");
  }
  console.log(`MongoDB OK (replica set ${hello.setName})`);

  // Una transacción abortada no debe dejar datos: es la garantía que usarán q14 y q15.
  const collection = db.collection("_check");
  await collection.deleteMany({});
  const session = mongo.startSession();
  try {
    session.startTransaction();
    await collection.insertOne({ prueba: true }, { session });
    await session.abortTransaction();
  } finally {
    await session.endSession();
  }
  const remaining = await collection.countDocuments();
  await collection.drop();
  if (remaining !== 0) {
    throw new Error("La transacción abortada dejó datos.");
  }
  console.log("Transacciones OK (rollback verificado)");

  console.log(`Redis OK (${await redis.ping()})`);
} finally {
  await redis.close();
  await mongo.close();
}
