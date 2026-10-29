import { describe, expect, it } from "vitest";

import { regionOf } from "../../src/ui/controlRefs";

function region(html: string): string {
  document.body.innerHTML = html;
  return regionOf(document.querySelector(".probe")!);
}

describe("regionOf", () => {
  it("counts a named popover with the controls that open it, not as a dialog", () => {
    expect(region('<div class="float-popover vc-pop" role="dialog"><button class="probe">Top</button></div>')).toBe(
      "views",
    );
    expect(
      region('<div class="float-popover rail-flyout" role="dialog"><button class="probe">Fillet</button></div>'),
    ).toBe("toolrail");
  });

  it("still counts any other dialog as one", () => {
    expect(region('<div class="console" role="dialog"><button class="probe">Close</button></div>')).toBe("dialog");
  });
});
