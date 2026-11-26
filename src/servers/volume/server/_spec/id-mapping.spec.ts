/**
 * Copyright (c) 2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Jose Duarte <jose.duarte@rcsb.org>
 */

import { createIdToPathMapper, isExtendedPdbId, isLegacyPdbId, normalizeId, toExtendedPdbId, toLegacyPdbId } from '../id-mapping';

describe('volume server id mapping', () => {
    describe('PDB id recognition', () => {
        it('recognizes legacy ids', () => {
            for (const id of ['1abc', '1ABC', '9zzz', '1a2b']) expect(isLegacyPdbId(id)).toBe(true);
            for (const id of ['0abc', 'abcd', '1ab', '1abcd', '1ab_', 'pdb_00001abc', '']) expect(isLegacyPdbId(id)).toBe(false);
        });

        it('recognizes extended ids', () => {
            for (const id of ['pdb_00001abc', 'PDB_00001ABC', 'pdb_00012abc']) expect(isExtendedPdbId(id)).toBe(true);
            for (const id of ['pdb_1abc', 'pdb_0001abc', 'pdb_000001abc', 'pdb-00001abc', 'xpdb_00001abc', '1abc', 'emd-1234']) expect(isExtendedPdbId(id)).toBe(false);
        });
    });

    describe('conversion', () => {
        it('converts legacy to extended', () => {
            expect(toExtendedPdbId('1ABC')).toBe('pdb_00001abc');
            expect(toExtendedPdbId('1cbs')).toBe('pdb_00001cbs');
            expect(toExtendedPdbId('PDB_00001CBS')).toBe('pdb_00001cbs');
            expect(toExtendedPdbId('pdb_00012abc')).toBe('pdb_00012abc');
            expect(toExtendedPdbId('emd-1234')).toBeUndefined();
        });

        it('converts extended to legacy only for the 4-character era', () => {
            expect(toLegacyPdbId('pdb_00001abc')).toBe('1abc');
            expect(toLegacyPdbId('PDB_00001ABC')).toBe('1abc');
            expect(toLegacyPdbId('1CBS')).toBe('1cbs');
            expect(toLegacyPdbId('pdb_00012abc')).toBeUndefined();
            expect(toLegacyPdbId('pdb_00000abc')).toBeUndefined();
            expect(toLegacyPdbId('emd-1234')).toBeUndefined();
        });

        it('round-trips', () => {
            for (const id of ['1abc', '4hhb', '9zzz']) expect(toLegacyPdbId(toExtendedPdbId(id)!)).toBe(id);
        });
    });

    describe('normalizeId', () => {
        it('only lowercases without a normalization', () => {
            expect(normalizeId('1ABC', undefined)).toBe('1abc');
            expect(normalizeId('PDB_00001ABC', undefined)).toBe('pdb_00001abc');
        });

        it('passes through ids the normalization does not apply to', () => {
            expect(normalizeId('EMD-1234', 'pdb-extended')).toBe('emd-1234');
            expect(normalizeId('EMD-1234', 'pdb-legacy')).toBe('emd-1234');
            expect(normalizeId('pdb_00012abc', 'pdb-legacy')).toBe('pdb_00012abc');
        });
    });

    describe('createIdToPathMapper', () => {
        const idMap: [string, string][] = [
            ['x-ray', '/mnt/xray/${id.substr(9, 2)}/${id}.mdb'],
            ['em', '/mnt/em/EMD-${id.substr(4, 5)}/emd_${id.substr(4, 5)}.mdb'],
        ];

        it('serves extended storage for legacy and extended requests', () => {
            const map = createIdToPathMapper(idMap, [['X-Ray', 'pdb-extended']]);
            expect(map('x-ray', '1CBS')).toBe('/mnt/xray/cb/pdb_00001cbs.mdb');
            expect(map('x-ray', '1cbs')).toBe('/mnt/xray/cb/pdb_00001cbs.mdb');
            expect(map('X-RAY', 'pdb_00001cbs')).toBe('/mnt/xray/cb/pdb_00001cbs.mdb');
            expect(map('x-ray', 'PDB_00001CBS')).toBe('/mnt/xray/cb/pdb_00001cbs.mdb');
            expect(map('x-ray', 'pdb_00012abc')).toBe('/mnt/xray/ab/pdb_00012abc.mdb');
        });

        it('serves legacy storage for legacy and extended requests', () => {
            const map = createIdToPathMapper([['x-ray', '/mnt/xray/${id.substr(1, 2)}/${id}.mdb']], [['x-ray', 'pdb-legacy']]);
            expect(map('x-ray', '1CBS')).toBe('/mnt/xray/cb/1cbs.mdb');
            expect(map('x-ray', 'pdb_00001cbs')).toBe('/mnt/xray/cb/1cbs.mdb');
        });

        it('keeps current behavior for types without a normalization', () => {
            const map = createIdToPathMapper(idMap, [['x-ray', 'pdb-extended']]);
            expect(map('em', 'EMD-8116')).toBe('/mnt/em/EMD-8116/emd_8116.mdb');
            expect(map('nosuch', '1cbs')).toBeUndefined();

            const plain = createIdToPathMapper([['x-ray', '/mnt/xray/${id.substr(1, 2)}/${id}.mdb']]);
            expect(plain('x-ray', '1CBS')).toBe('/mnt/xray/cb/1cbs.mdb');
        });

        it('rejects unknown normalizations', () => {
            expect(() => createIdToPathMapper(idMap, [['x-ray', 'pdb-whatever']])).toThrow(/Invalid idNormalization/);
        });
    });
});
