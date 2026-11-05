import type { Db } from "mongodb";
import { ProductosRepository } from "../productos/repository.js";
import { ProveedoresRepository } from "../proveedores/repository.js";
import type { RedisClient } from "./db.js";

/** Crea un repositorio por dominio, cada uno con el motor que usa. */
export function crearRepositorios(db: Db, redis: RedisClient) {
  return {
    productos: new ProductosRepository(db),
    proveedores: new ProveedoresRepository(redis),
  };
}

export type Repositorios = ReturnType<typeof crearRepositorios>;
