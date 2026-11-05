import { existsSync, readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

export type Fila = Record<string, string>;

const DATA = new URL("../../data/", import.meta.url);

/**
 * Lee un dataset completo: el CSV provisto por la cátedra más, si existe, el CSV
 * homónimo con los registros adicionales del equipo (data/adicionales/<nombre>.csv).
 */
export function leerDataset(nombre: string): Fila[] {
  return ["provistos", "adicionales"].flatMap((carpeta) => {
    const archivo = new URL(`${carpeta}/${nombre}.csv`, DATA);
    if (!existsSync(archivo)) return [];
    return parse(readFileSync(archivo, "utf8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true,
    }) as Fila[];
  });
}

// Conversores de campos. Según el enunciado, un campo vacío representa null.

export function requerido(fila: Fila, campo: string): string {
  const valor = fila[campo];
  if (valor === undefined || valor === "") {
    throw new Error(`Falta "${campo}" en ${JSON.stringify(fila)}`);
  }
  return valor;
}

export function opcional(fila: Fila, campo: string): string | null {
  const valor = fila[campo];
  return valor === undefined || valor === "" ? null : valor;
}

export function entero(fila: Fila, campo: string): number {
  const valor = requerido(fila, campo);
  if (!/^-?\d+$/.test(valor)) {
    throw new Error(`"${campo}" no es un entero en ${JSON.stringify(fila)}`);
  }
  return Number(valor);
}

export function booleano(fila: Fila, campo: string): boolean {
  const valor = requerido(fila, campo);
  if (valor === "True") return true;
  if (valor === "False") return false;
  throw new Error(`"${campo}" no es True/False en ${JSON.stringify(fila)}`);
}

export function unoDe<const T extends string>(fila: Fila, campo: string, valores: readonly T[]): T {
  const valor = requerido(fila, campo);
  if (!(valores as readonly string[]).includes(valor)) {
    throw new Error(`"${campo}" debe ser uno de ${valores.join(", ")} en ${JSON.stringify(fila)}`);
  }
  return valor as T;
}
