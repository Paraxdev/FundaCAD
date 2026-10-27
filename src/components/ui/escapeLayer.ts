// Window capture listeners run in the order added, so an overlay opened over another cannot stop the older one from
// hearing Escape first. Each open Menu and Popover takes a layer, and only the topmost acts on the key.

const layers: object[] = [];

export function escapeLayer(): { isTop: () => boolean; release: () => void } {
  const me = {};
  layers.push(me);
  return {
    isTop: () => layers[layers.length - 1] === me,
    release: () => {
      const i = layers.indexOf(me);
      if (i >= 0) layers.splice(i, 1);
    },
  };
}
