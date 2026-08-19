// Multi-object B-rep model management for the standalone sandbox.
//
// Unlike InventorRayOptics (exactly one shape per Inventor document), any number of
// STEP files and/or demo shapes can be loaded side by side here, and each can be
// removed independently. Every loaded top-level shape is immediately exploded into its
// constituent solids — a multi-solid STEP file becomes several independently-named,
// independently-removable entries at the same granularity as everything else — since
// occt.js/brepTracer.js's whole B-rep pipeline (buildFaceTable, the tracer) always
// operates on a single combined shape. Add/remove just rebuilds that combined compound
// from whichever solids are currently loaded and reruns buildFaceTable on it.
//
// A solid extracted via TopExp_Explorer + TopoDS.Solid_1 survives independently of the
// shape it was extracted from (verified live: deleting the parent shape/maker entirely
// afterward does not invalidate it — OCCT's underlying TShape is refcounted), so no
// expensive deep-copy is needed here.

export function makeSceneModel(oc) {
  let nextObjectId = 1;
  const loaded = []; // [{id, name, shape}] — one entry per independently-tracked solid

  function explodeIntoSolids(shape, baseName) {
    const solids = [];
    const explorer = new oc.TopExp_Explorer_1();
    for (
      explorer.Init(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      explorer.More();
      explorer.Next()
    ) {
      solids.push(oc.TopoDS.Solid_1(explorer.Current()));
    }
    explorer.delete();
    if (solids.length === 0) throw new Error(`${baseName}: no solids found (surfaces/shells alone aren't supported here)`);
    return solids.map((solidShape, i) => ({
      id: nextObjectId++,
      name: solids.length > 1 ? `${baseName} (${i + 1})` : baseName,
      shape: solidShape,
    }));
  }

  return {
    /** Adds every solid found in `shape` (already-read, e.g. from readStepFromUrl or a
     * demo-shape maker) as new independently-tracked entries. Returns the new entries. */
    add(shape, baseName) {
      const entries = explodeIntoSolids(shape, baseName);
      loaded.push(...entries);
      return entries;
    },

    remove(id) {
      const idx = loaded.findIndex((e) => e.id === id);
      if (idx < 0) return;
      loaded[idx].shape.delete();
      loaded.splice(idx, 1);
    },

    clear() {
      for (const e of loaded) e.shape.delete();
      loaded.length = 0;
    },

    get entries() { return loaded; },

    /** Combines every currently-loaded solid into one compound — the caller (a fresh
     * buildFaceTable call) is responsible for deleting the returned compound/builder
     * once done with it, same as any other shape occt.js hands back. Returns null if
     * nothing is loaded. */
    buildCompound() {
      if (loaded.length === 0) return null;
      const builder = new oc.BRep_Builder();
      const compound = new oc.TopoDS_Compound();
      builder.MakeCompound(compound);
      for (const e of loaded) builder.Add(compound, e.shape);
      builder.delete();
      return compound;
    },
  };
}

// ---------------------------------------------------------------- demo shapes

// Equilateral triangular prism (like a classic dispersing prism), built via a
// polygon -> wire -> face -> prism-extrude, matching what BRepPrimAPI actually offers
// (there's no single "make N-gon prism" primitive) — verified live against this exact
// WASM build before writing this.
export function makeDemoPrismShape(oc, size = 20) {
  const h = size, r = size * 0.7;
  const poly = new oc.BRepBuilderAPI_MakePolygon_1();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    const p = new oc.gp_Pnt_3(Math.cos(a) * r, Math.sin(a) * r, -h / 2);
    poly.Add_1(p);
    p.delete();
  }
  poly.Close();
  const faceMaker = new oc.BRepBuilderAPI_MakeFace_15(poly.Wire(), false);
  const vec = new oc.gp_Vec_4(0, 0, h);
  const prismMaker = new oc.BRepPrimAPI_MakePrism_1(faceMaker.Face(), vec, false, true);
  const shape = prismMaker.Shape();
  poly.delete(); faceMaker.delete(); vec.delete(); prismMaker.delete();
  return shape;
}

// Ball lens — a sphere is a single analytic B-rep surface.
export function makeDemoSphereShape(oc, radius = 12) {
  const sphereMaker = new oc.BRepPrimAPI_MakeSphere_1(radius);
  const shape = sphereMaker.Shape();
  sphereMaker.delete();
  return shape;
}
