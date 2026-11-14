import type { Db } from "mongodb";
import type { Driver } from "neo4j-driver";
import { ClientesRepository } from "../clientes/repository.js";
import { FarmaceuticosRepository } from "../farmaceuticos/repository.js";
import { LotesRepository } from "../lotes/repository.js";
import { ProductosRepository } from "../productos/repository.js";
import { ProveedoresRepository } from "../proveedores/repository.js";
import { RecetasRepository } from "../recetas/repository.js";
import { SucursalesRepository } from "../sucursales/repository.js";
import { VentasRepository } from "../ventas/repository.js";
import { TransaccionesMongo } from "./transacciones.js";

/**
 * Crea un repositorio por dominio, cada uno con los motores que usa, y el acceso a las
 * transacciones de MongoDB que usan los servicios de escritura.
 */
export function crearRepositorios(db: Db, neo4j: Driver) {
  return {
    clientes: new ClientesRepository(db, neo4j),
    farmaceuticos: new FarmaceuticosRepository(neo4j),
    lotes: new LotesRepository(db, neo4j),
    productos: new ProductosRepository(db, neo4j),
    proveedores: new ProveedoresRepository(neo4j),
    recetas: new RecetasRepository(db),
    sucursales: new SucursalesRepository(neo4j),
    ventas: new VentasRepository(db, neo4j),
    transacciones: new TransaccionesMongo(db),
  };
}

export type Repositorios = ReturnType<typeof crearRepositorios>;
