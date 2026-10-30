import type { SketchBinding } from "../document/store";
import type { FieldKind } from "../document/numFields";
import type { DimInput } from "../sketch/dimInput";
import { isNumericLiteral } from "../params/parse";
import type { ParamTarget } from "../types";

/** A value box field and the feature field it writes, with the number the feature gets. */
export interface BoxField {
  box: string;
  field: string;
  value: number;
  kind?: FieldKind;
}

interface BoundSource {
  boundExpr(target: ParamTarget): { expr: string } | null;
}

/** The parameter bindings a tool commits with its feature, written as a History step row writes them: a typed
 *  expression binds the field, and a number replaces a plain number binding or an expression the user typed over. */
export function boxBindings(dim: DimInput, store: BoundSource, feature: string, fields: BoxField[]): SketchBinding[] {
  const out: SketchBinding[] = [];
  for (const f of fields) {
    const target: ParamTarget = { kind: "feature", feature, field: f.field };
    const kind = f.kind ?? "length";
    const typed = dim.exprOf(f.box);
    if (typed) {
      out.push({ target, kind, ...typed });
      continue;
    }
    const bound = store.boundExpr(target);
    if (bound && (isNumericLiteral(bound.expr) || dim.isUserDriven(f.box))) {
      out.push({ target, kind, expr: String(f.value) });
    }
  }
  return out;
}
