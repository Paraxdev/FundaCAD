import { mount } from "@vue/test-utils";

import Checkbox from "../../src/components/ui/Checkbox.vue";
import ChoiceList from "../../src/components/ui/ChoiceList.vue";
import NumberField from "../../src/components/ui/NumberField.vue";
import Segmented from "../../src/components/ui/Segmented.vue";
import Select from "../../src/components/ui/Select.vue";
import Slider from "../../src/components/ui/Slider.vue";
import Tabs from "../../src/components/ui/Tabs.vue";
import TextField from "../../src/components/ui/TextField.vue";

// Never run, vue-tsc checks it: an unused expect-error fails the type check when a control stops requiring a name.
export function baseControlsNeedAName() {
  const options = [{ value: "a", label: "A" }] as const;
  const tabs = [{ value: "a", label: "A" }] as const;

  mount(Select, { props: { modelValue: "a", options, label: "Fruit" } });
  mount(Select, { props: { modelValue: "a", options, labelledby: "fruit-label" } });
  // @ts-expect-error a Select needs a label or labelledby
  mount(Select, { props: { modelValue: "a", options } });
  // @ts-expect-error a Select takes a label or labelledby, not both
  mount(Select, { props: { modelValue: "a", options, label: "Fruit", labelledby: "fruit-label" } });

  mount(ChoiceList, { props: { modelValue: "a", options, label: "Fruit" } });
  // @ts-expect-error a ChoiceList needs a label or labelledby
  mount(ChoiceList, { props: { modelValue: "a", options } });

  mount(TextField, { props: { modelValue: "", label: "Name" } });
  // @ts-expect-error a TextField needs a label or labelledby
  mount(TextField, { props: { modelValue: "" } });
  // @ts-expect-error a TextField takes a label or labelledby, not both
  mount(TextField, { props: { modelValue: "", label: "Name", labelledby: "name-label" } });

  mount(NumberField, { props: { modelValue: 1, label: "Depth" } });
  // @ts-expect-error a NumberField needs a label or labelledby
  mount(NumberField, { props: { modelValue: 1 } });

  mount(Slider, { props: { modelValue: 1, label: "Threshold" } });
  // @ts-expect-error a Slider needs a label or labelledby
  mount(Slider, { props: { modelValue: 1 } });

  mount(Segmented, { props: { modelValue: "a", options, label: "Alignment" } });
  // @ts-expect-error a Segmented needs a label or labelledby
  mount(Segmented, { props: { modelValue: "a", options } });

  mount(Tabs, { props: { modelValue: "a", tabs, label: "Sections" } });
  // @ts-expect-error Tabs need a label or labelledby
  mount(Tabs, { props: { modelValue: "a", tabs } });

  // Slot text can name a Checkbox and a type cannot see a slot, so only label plus labelledby is refused.
  mount(Checkbox, { props: { modelValue: false } });
  // @ts-expect-error a Checkbox takes a label or labelledby, not both
  mount(Checkbox, { props: { modelValue: false, label: "Snap", labelledby: "snap-label" } });
}
