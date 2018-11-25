/**
 * Copyright (c) 2018 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Unit, StructureElement, ElementIndex, ResidueIndex } from 'mol-model/structure';
import { Segmentation } from 'mol-data/int';
import { MoleculeType, SecondaryStructureType } from 'mol-model/structure/model/types';
import Iterator from 'mol-data/iterator';
import { Vec3 } from 'mol-math/linear-algebra';
import SortedRanges from 'mol-data/int/sorted-ranges';
import { CoarseSphereConformation, CoarseGaussianConformation } from 'mol-model/structure/model/properties/coarse';
import { getPolymerRanges } from '../polymer';
import { AtomicConformation } from 'mol-model/structure/model/properties/atomic';

/**
 * Iterates over individual residues/coarse elements in polymers of a unit while
 * providing information about the neighbourhood in the underlying model for drawing splines
 */
export function PolymerTraceIterator(unit: Unit): Iterator<PolymerTraceElement> {
    switch (unit.kind) {
        case Unit.Kind.Atomic: return new AtomicPolymerTraceIterator(unit)
        case Unit.Kind.Spheres:
        case Unit.Kind.Gaussians:
            return new CoarsePolymerTraceIterator(unit)
    }
}

interface PolymerTraceElement {
    center: StructureElement
    first: boolean, last: boolean
    secStrucFirst: boolean, secStrucLast: boolean
    secStrucType: SecondaryStructureType
    moleculeType: MoleculeType

    p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, p4: Vec3
    d12: Vec3, d23: Vec3
}

const SecStrucTypeNA = SecondaryStructureType.create(SecondaryStructureType.Flag.NA)

function createPolymerTraceElement (unit: Unit): PolymerTraceElement {
    return {
        center: StructureElement.create(unit),
        first: false, last: false,
        secStrucFirst: false, secStrucLast: false,
        secStrucType: SecStrucTypeNA,
        moleculeType: MoleculeType.unknown,
        p0: Vec3.zero(), p1: Vec3.zero(), p2: Vec3.zero(), p3: Vec3.zero(), p4: Vec3.zero(),
        d12: Vec3.create(1, 0, 0), d23: Vec3.create(1, 0, 0),
    }
}

const enum AtomicPolymerTraceIteratorState { nextPolymer, nextResidue }

export class AtomicPolymerTraceIterator implements Iterator<PolymerTraceElement> {
    private value: PolymerTraceElement
    private polymerIt: SortedRanges.Iterator<ElementIndex, ResidueIndex>
    private residueIt: Segmentation.SegmentIterator<ResidueIndex>
    private polymerSegment: Segmentation.Segment<ResidueIndex>
    private cyclicPolymerMap: Map<ResidueIndex, ResidueIndex>
    private secondaryStructureType: ArrayLike<SecondaryStructureType>
    private residueSegmentMin: ResidueIndex
    private residueSegmentMax: ResidueIndex
    private prevSecStrucType: SecondaryStructureType
    private currSecStrucType: SecondaryStructureType
    private nextSecStrucType: SecondaryStructureType
    private state: AtomicPolymerTraceIteratorState = AtomicPolymerTraceIteratorState.nextPolymer
    private residueAtomSegments: Segmentation<ElementIndex, ResidueIndex>
    private traceElementIndex: ArrayLike<ElementIndex>
    private directionElementIndex: ArrayLike<ElementIndex>
    private moleculeType: ArrayLike<MoleculeType>
    private atomicConformation: AtomicConformation

    private p0 = Vec3.zero();
    private p1 = Vec3.zero();
    private p2 = Vec3.zero();
    private p3 = Vec3.zero();
    private p4 = Vec3.zero();
    private p5 = Vec3.zero();
    private p6 = Vec3.zero();

    // private v01 = Vec3.zero();
    private v12 = Vec3.zero();
    private v23 = Vec3.zero();
    // private v34 = Vec3.zero();

    hasNext: boolean = false;

    private pos(target: Vec3, index: number) {
        target[0] = this.atomicConformation.x[index]
        target[1] = this.atomicConformation.y[index]
        target[2] = this.atomicConformation.z[index]
    }

    private updateResidueSegmentRange(polymerSegment: Segmentation.Segment<ResidueIndex>) {
        const { index } = this.residueAtomSegments
        this.residueSegmentMin = index[this.unit.elements[polymerSegment.start]]
        this.residueSegmentMax = index[this.unit.elements[polymerSegment.end - 1]]
    }

    private getResidueIndex(residueIndex: number) {
        if (residueIndex < this.residueSegmentMin) {
            const cyclicIndex = this.cyclicPolymerMap.get(this.residueSegmentMin)
            if (cyclicIndex !== undefined) {
                residueIndex = cyclicIndex - (this.residueSegmentMin - residueIndex - 1)
            } else {
                residueIndex = this.residueSegmentMin
            }
        } else if (residueIndex > this.residueSegmentMax) {
            const cyclicIndex = this.cyclicPolymerMap.get(this.residueSegmentMax)
            if (cyclicIndex !== undefined) {
                residueIndex = cyclicIndex + (residueIndex - this.residueSegmentMax - 1)
            } else {
                residueIndex = this.residueSegmentMax
            }
        }
        return residueIndex as ResidueIndex
    }

    private setControlPoint(out: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, residueIndex: ResidueIndex) {
        const ss =  this.secondaryStructureType[residueIndex]
        if (SecondaryStructureType.is(ss, SecondaryStructureType.Flag.Beta)) {
            Vec3.scale(out, Vec3.add(out, p1, Vec3.add(out, p3, Vec3.add(out, p2, p2))), 1/4)
        } else {
            Vec3.copy(out, p2)
        }
    }

    move() {
        const { residueIt, polymerIt, value } = this

        if (this.state === AtomicPolymerTraceIteratorState.nextPolymer) {
            while (polymerIt.hasNext) {
                this.polymerSegment = polymerIt.move();
                residueIt.setSegment(this.polymerSegment);
                this.updateResidueSegmentRange(this.polymerSegment)
                if (residueIt.hasNext) {
                    this.state = AtomicPolymerTraceIteratorState.nextResidue
                    this.currSecStrucType = SecStrucTypeNA
                    this.nextSecStrucType = this.secondaryStructureType[this.residueSegmentMin]
                    break
                }
            }
        }

        if (this.state === AtomicPolymerTraceIteratorState.nextResidue) {
            const { index: residueIndex } = residueIt.move();
            this.prevSecStrucType = this.currSecStrucType
            this.currSecStrucType = this.nextSecStrucType
            this.nextSecStrucType = residueIt.hasNext ? this.secondaryStructureType[residueIndex + 1] : SecStrucTypeNA

            value.secStrucType = this.currSecStrucType
            value.center.element = this.traceElementIndex[residueIndex]
            value.first = residueIndex === this.residueSegmentMin
            value.last = residueIndex === this.residueSegmentMax
            value.secStrucFirst = this.prevSecStrucType !== this.currSecStrucType
            value.secStrucLast = this.currSecStrucType !== this.nextSecStrucType
            value.moleculeType = this.moleculeType[residueIndex]

            if (value.first) {
                this.pos(this.p0, this.traceElementIndex[this.getResidueIndex(residueIndex - 3)])
                this.pos(this.p1, this.traceElementIndex[this.getResidueIndex(residueIndex - 2)])
                this.pos(this.p2, this.traceElementIndex[this.getResidueIndex(residueIndex - 1)])
                this.pos(this.p3, value.center.element)
                this.pos(this.p4, this.traceElementIndex[this.getResidueIndex(residueIndex + 1)])
                this.pos(this.p5, this.traceElementIndex[this.getResidueIndex(residueIndex + 2)])

                this.pos(this.v12, this.directionElementIndex[this.getResidueIndex(residueIndex - 1)])
            } else {
                Vec3.copy(this.p0, this.p1)
                Vec3.copy(this.p1, this.p2)
                Vec3.copy(this.p2, this.p3)
                Vec3.copy(this.p3, this.p4)
                Vec3.copy(this.p4, this.p5)
                Vec3.copy(this.p5, this.p6)

                Vec3.copy(this.v12, this.v23)
            }
            this.pos(this.p6,  this.traceElementIndex[this.getResidueIndex(residueIndex + 3 as ResidueIndex)])
            this.pos(this.v23, this.directionElementIndex[residueIndex])

            this.setControlPoint(value.p0, this.p0, this.p1, this.p2, residueIndex - 2 as ResidueIndex)
            this.setControlPoint(value.p1, this.p1, this.p2, this.p3, residueIndex - 1 as ResidueIndex)
            this.setControlPoint(value.p2, this.p2, this.p3, this.p4, residueIndex)
            this.setControlPoint(value.p3, this.p3, this.p4, this.p5, residueIndex + 1 as ResidueIndex)
            this.setControlPoint(value.p4, this.p4, this.p5, this.p6, residueIndex + 2 as ResidueIndex)

            Vec3.copy(value.d12, this.v12)
            Vec3.copy(value.d23, this.v23)

            if (!residueIt.hasNext) {
                this.state = AtomicPolymerTraceIteratorState.nextPolymer
            }
        }

        this.hasNext = residueIt.hasNext || polymerIt.hasNext

        return this.value;
    }

    constructor(private unit: Unit.Atomic) {
        this.atomicConformation = unit.model.atomicConformation
        this.residueAtomSegments = unit.model.atomicHierarchy.residueAtomSegments
        this.traceElementIndex = unit.model.atomicHierarchy.derived.residue.traceElementIndex
        this.directionElementIndex = unit.model.atomicHierarchy.derived.residue.directionElementIndex
        this.moleculeType = unit.model.atomicHierarchy.derived.residue.moleculeType
        this.cyclicPolymerMap = unit.model.atomicHierarchy.cyclicPolymerMap
        this.secondaryStructureType = unit.model.properties.secondaryStructure.type
        this.polymerIt = SortedRanges.transientSegments(getPolymerRanges(unit), unit.elements)
        this.residueIt = Segmentation.transientSegments(this.residueAtomSegments, unit.elements);
        this.value = createPolymerTraceElement(unit)
        this.hasNext = this.residueIt.hasNext && this.polymerIt.hasNext
    }
}

const enum CoarsePolymerTraceIteratorState { nextPolymer, nextElement }

export class CoarsePolymerTraceIterator implements Iterator<PolymerTraceElement> {
    private value: PolymerTraceElement
    private polymerIt: SortedRanges.Iterator<ElementIndex, ResidueIndex>
    private polymerSegment: Segmentation.Segment<ResidueIndex>
    private state: CoarsePolymerTraceIteratorState = CoarsePolymerTraceIteratorState.nextPolymer
    private conformation: CoarseSphereConformation | CoarseGaussianConformation
    private elementIndex: number
    hasNext: boolean = false;

    private pos(target: Vec3, elementIndex: number) {
        elementIndex = Math.min(Math.max(this.polymerSegment.start, elementIndex), this.polymerSegment.end - 1)
        const index = this.unit.elements[elementIndex]
        target[0] = this.conformation.x[index]
        target[1] = this.conformation.y[index]
        target[2] = this.conformation.z[index]
    }

    move() {
        if (this.state === CoarsePolymerTraceIteratorState.nextPolymer) {
            while (this.polymerIt.hasNext) {
                this.polymerSegment = this.polymerIt.move();
                this.elementIndex = this.polymerSegment.start

                if (this.elementIndex + 1 < this.polymerSegment.end) {
                    this.state = CoarsePolymerTraceIteratorState.nextElement
                    break
                }
            }
        }

        if (this.state === CoarsePolymerTraceIteratorState.nextElement) {
            this.elementIndex += 1
            this.value.center.element = this.value.center.unit.elements[this.elementIndex]

            this.pos(this.value.p0, this.elementIndex - 2)
            this.pos(this.value.p1, this.elementIndex - 1)
            this.pos(this.value.p2, this.elementIndex)
            this.pos(this.value.p3, this.elementIndex + 1)
            this.pos(this.value.p4, this.elementIndex + 2)

            this.value.first = this.elementIndex === this.polymerSegment.start
            this.value.last = this.elementIndex === this.polymerSegment.end - 1

            if (this.elementIndex + 1 >= this.polymerSegment.end) {
                this.state = CoarsePolymerTraceIteratorState.nextPolymer
            }
        }

        this.hasNext = this.elementIndex + 1 < this.polymerSegment.end || this.polymerIt.hasNext
        return this.value;
    }

    constructor(private unit: Unit.Spheres | Unit.Gaussians) {
        this.polymerIt = SortedRanges.transientSegments(getPolymerRanges(unit), unit.elements);
        this.value = createPolymerTraceElement(unit)
        switch (unit.kind) {
            case Unit.Kind.Spheres: this.conformation = unit.model.coarseConformation.spheres; break
            case Unit.Kind.Gaussians: this.conformation = unit.model.coarseConformation.gaussians; break
        }
        this.hasNext = this.polymerIt.hasNext
    }
}