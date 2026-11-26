/**
 * Copyright (c) 2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Jose Duarte <jose.duarte@rcsb.org>
 */

import { interpolateIdPath, validateIdPathTemplate } from '../../../mol-util/string';

/**
 * How the `id` of a request is rewritten before it is interpolated into the `idMap` path template.
 * - `pdb-extended`: legacy 4-character PDB ids become extended ids (`1ABC` -> `pdb_00001abc`).
 * - `pdb-legacy`: extended ids of the 4-character era become legacy ids (`pdb_00001abc` -> `1abc`).
 * Ids that are not PDB ids of the expected form are passed through (lowercased).
 */
export type IdNormalization = 'pdb-extended' | 'pdb-legacy';
export const IdNormalizations: ReadonlyArray<IdNormalization> = ['pdb-extended', 'pdb-legacy'];

export function isIdNormalization(value: unknown): value is IdNormalization {
    return IdNormalizations.indexOf(value as IdNormalization) >= 0;
}

/** Legacy PDB id: a digit 1-9 followed by 3 alphanumeric characters. */
const LegacyPdbIdRegex = /^[1-9][a-z0-9]{3}$/i;
/** Extended PDB id: `pdb_` followed by 8 alphanumeric characters. */
const ExtendedPdbIdRegex = /^pdb_[a-z0-9]{8}$/i;
/** Prefix shared by all extended ids that have a legacy equivalent. */
const ExtendedLegacyPrefix = 'pdb_0000';

export function isLegacyPdbId(id: string) {
    return LegacyPdbIdRegex.test(id);
}

export function isExtendedPdbId(id: string) {
    return ExtendedPdbIdRegex.test(id);
}

/** `1ABC` -> `pdb_00001abc`; an extended id is lowercased; anything else gives `undefined`. */
export function toExtendedPdbId(id: string): string | undefined {
    if (isExtendedPdbId(id)) return id.toLowerCase();
    if (isLegacyPdbId(id)) return `${ExtendedLegacyPrefix}${id.toLowerCase()}`;
    return void 0;
}

/** `pdb_00001ABC` -> `1abc`; a legacy id is lowercased; an extended id without a legacy equivalent or anything else gives `undefined`. */
export function toLegacyPdbId(id: string): string | undefined {
    if (isLegacyPdbId(id)) return id.toLowerCase();
    if (isExtendedPdbId(id)) {
        const lower = id.toLowerCase();
        if (!lower.startsWith(ExtendedLegacyPrefix)) return void 0;
        const legacy = lower.substring(ExtendedLegacyPrefix.length);
        return isLegacyPdbId(legacy) ? legacy : void 0;
    }
    return void 0;
}

/** Lowercases `id` and applies `normalization`, if any; ids the normalization does not apply to are only lowercased. */
export function normalizeId(id: string, normalization: IdNormalization | undefined): string {
    const lower = id.toLowerCase();
    switch (normalization) {
        case 'pdb-extended': return toExtendedPdbId(lower) ?? lower;
        case 'pdb-legacy': return toLegacyPdbId(lower) ?? lower;
        default: return lower;
    }
}

/**
 * Creates the function that maps a request's `type` (source) and `id` to a file path or URL.
 * `type` is case-insensitive; returns `undefined` for a type without an `idMap` entry.
 */
export function createIdToPathMapper(idMap: ReadonlyArray<[string, string]>, idNormalization: ReadonlyArray<[string, string]> = []) {
    const paths = new Map<string, string>();
    for (const [type, path] of idMap) {
        validateIdPathTemplate(path);
        paths.set(type.toLowerCase(), path);
    }

    const normalizations = new Map<string, IdNormalization>();
    for (const [type, normalization] of idNormalization) {
        if (!isIdNormalization(normalization)) {
            throw new Error(`Invalid idNormalization '${normalization}' for type '${type}', expected one of: ${IdNormalizations.join(', ')}.`);
        }
        normalizations.set(type.toLowerCase(), normalization);
    }

    return (type: string, id: string): string | undefined => {
        const key = type.toLowerCase();
        const path = paths.get(key);
        return path ? interpolateIdPath(path, normalizeId(id, normalizations.get(key))) : void 0;
    };
}
