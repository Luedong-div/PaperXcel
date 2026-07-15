---
name: paperxcel-theoretical-chemistry
description: Use for PaperXcel analysis of quantum chemistry, theoretical chemistry, electronic-structure, DFT, ab initio, molecular simulation, Hamiltonian, basis-set, electron-correlation, pseudopotential, relativistic, convergence, or computational-chemistry papers. Apply only when the paper or user request is actually in this domain.
---

# PaperXcel Theoretical Chemistry

Add theoretical-chemistry checks to the general PaperXcel evidence workflow. Do not assume these fields apply to unrelated papers.

## Method Checklist

Extract only what the evidence confirms:

- studied system, composition, geometry, charge, multiplicity, state, and environment;
- Hamiltonian or governing model and its stated assumptions;
- electronic-structure or simulation method and level of theory;
- basis set, functional, ECP or pseudopotential, and electron-correlation treatment;
- relativistic, solvation, embedding, periodic, thermal, or dynamical treatment;
- software, version, numerical thresholds, convergence criteria, grids, cutoffs, and geometry protocol;
- observables, units, reference states, benchmark data, error measures, and uncertainty;
- stated applicability limits, failure modes, and computational cost.

Write `不适用` for genuinely irrelevant fields and `当前证据未确认` for relevant but missing fields.

## Formula Handling

- Preserve the paper's symbols and units.
- Explain each term, approximation, boundary condition, and link to the reported result.
- Do not reconstruct unseen terms or assign a standard Hamiltonian merely from the method name.
- Keep equations in Markdown/KaTeX-compatible notation when rewriting them.

## Cross-Paper Comparison

Check whether the papers use comparable systems, geometries, basis quality, correlation levels, relativistic treatment, observables, and reference data before comparing accuracy or cost. Mark any conclusion that combines multiple papers as `跨文献推断`.

Use `【p.X】` for one paper and `【P1 p.X】` for multiple papers. Never invent page-level evidence.
