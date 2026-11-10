import type { Db } from "mongodb";
import type { Driver } from "neo4j-driver";
import { ClientesRepository } from "../clientes/repository.js";
import { LotesRepository } from "../lotes/repository.js";
import { ProductosRepository } from "../productos/repository.js";
import { ProveedoresRepository } from "../proveedores/repository.js";
import { SucursalesRepository } from "../sucursales/repository.js";

/** Crea un repositorio por dominio, cada uno con los motores que usa. */
export function crearRepositorios(db: Db, neo4j: Driver) {
  return {
    clientes: new ClientesRepository(db, neo4j),
    lotes: new LotesRepository(db, neo4j),
    productos: new ProductosRepository(db, neo4j),
    proveedores: new ProveedoresRepository(neo4j),
    sucursales: new SucursalesRepository(neo4j),
  };
}

export type Repositorios = ReturnType<typeof crearRepositorios>;
