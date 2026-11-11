# Model-directed drawing / الرسم الاحترافي بواسطة النموذج

ArtForge renders geometry; the calling model supplies composition and artistic decisions. No model API, paid generation or credentials are required by this interface. Vision-capable models can inspect the returned PNG; other models cannot establish visual acceptance.

## Workflow

1. Call capabilities, then plan the user request. Read the selected palettes, referenceContext concepts and exact operation docs. If the built-in composer lacks the subject, construct sceneSpec instead of substituting a text card.
2. List the required objects, counts and relationships in element descriptions. Decide viewpoint, focal point, silhouettes, material values and one coherent lighting direction before adding details. Keep the instruction separate from literal copy.
3. Build layers back-to-front. Use a few large value masses first, then contact shadows, material planes, highlights and selective details. Use paths and curves for organic silhouettes rather than assembling every contour from rectangles.
4. Use sceneSpec version 1. Every primitive operation identifies one layer and one element. Coordinates are pixels in the requested canvas. Use $color.accent, $color.secondary, $color.background, $color.backgroundAlt and $color.text to bind real selected palette roles. Do not use operation placeholders, file paths or network inputs.
5. To apply a selected book or styleguide, record its actual selected sourceId, the concrete decision and the zero-based operationIndexes that implement it. These are declared decisions, not automatic proof that the reference was applied correctly. Do not copy book text or reference artwork into the design.
6. Execute the plan, inspect the returned PNG, then use document.info to locate object IDs and send ALL edits together in ONE artforge_tool_op call: op "batch", params {documentId, ops:[{op:"object.update", params:{...}}, ...]}; the reply includes the updated preview. Each separate call costs about 4 s through ChatGPT. Allow at most two correction cycles before reporting remaining limitations. Save and export after edits.
7. Report execution, structural completeness and visual review separately. Structural PASS never means professional artistic quality. Counts and relationships need visual review; element tags prove only operation coverage.

## Minimal contract example

```json
{
  "prompt": "A simple abstract circular composition, no text",
  "width": 900,
  "height": 900,
  "sceneSpec": {
    "version": 1,
    "elements": [{"id":"disc","description":"One large focal disc with space around it"}],
    "layers": [{"id":"art","name":"Artwork"}],
    "operations": [{"op":"draw.ellipse","layer":"art","element":"disc","params":{"x":180,"y":180,"w":540,"h":540,"fill":"$color.accent"}}]
  }
}
```

Allowed ops (exactly `scene-spec.js` DRAW_OPS): draw.rect, draw.ellipse, draw.line, draw.polygon, draw.path, draw.gradient, draw.brush, draw.stroke, draw.text. Use draw.stroke for tapered ink lines that must stay vector in SVG/PDF; draw.brush for textured strokes; draw.path for organic silhouettes. Read the exact drawing docs before choosing parameters. Maximum: 80 elements, 20 layers, 1200 operations, 1.5 MB. Layer order controls paint order; operations may not select external document or layer IDs. Missing required elements cause structural verification failure. Unsupported input fails before document creation.

Text parameters are `font:{family,size,weight,lineHeight}`, `rtl:true`, `align:"right"`. Top-level fontSize/fontFamily/fontWeight/direction are invalid. Do not assume another canvas API parameter convention.

## After execution: finishing with the engine tools
sceneSpec builds the drawing; finishing is done afterwards in ONE `artforge_tool_op` batch on the returned documentId (guide `editing-workflow`):
- layer effects, masks, clipping, adjustment layers and smart filters — guide `layers-and-effects` (e.g. dropShadow on the title layer, gaussianBlur on the far layer, a curves layer for contrast);
- parametric shapes, booleans, vector networks and the vector bucket — guide `drawing` (`draw.shape`, `path.boolean`, `draw.network`, `vector.fill` are not sceneSpec ops);
- pixel retouching or warping — guide `pixels-and-retouch`.
Read `layer.list` / `object.list` first; layer ids in the document are not the sceneSpec layer ids.

## Cached connector schemas
If a client strips sceneSpec from the planning tool inputs, call `artforge_tool_op` with `op:"design.plan"` and `params` equal to the full planning input including sceneSpec. This forwards to the same planner and validators, saves a plan, and creates no document. Execute the returned planId through artforge_execute_design. Older clients can read this guide using artforge_tool_docs with query:"model-drawing". Never accept a returned plan whose design.elements/coverage omit the required scene elements.
