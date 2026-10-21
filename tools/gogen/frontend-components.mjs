// @ts-check
// Strong components give cyclic semantic dependencies one content certificate.
// Component numbers are traversal bookkeeping; only sorted symbolic members and
// child content hashes enter keys. The walk is iterative for long dependency chains.
/** @param {Record<string, {owner: string, dependencies: readonly string[]}>} nodes @param {{test(name: string): boolean} | undefined} [drop] */
export function graphComponents(nodes, drop) {
  const ids = Object.keys(nodes), edges = new Map(), reverse = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    const next = drop?.test(nodes[id].owner) ? [] : nodes[id].dependencies
      .filter((key) => nodes[key] && !drop?.test(nodes[key].owner));
    edges.set(id, next);
    // @ts-expect-error -- abapiti form pending
    for (const key of next) reverse.get(key).push(id);
  }
  const seen = new Set(), ordered = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stack = [{id, next: 0}];
    while (stack.length) {
      const frame = /** @type {{id: string, next: number}} */ (stack.at(-1)), next = edges.get(frame.id);
      if (frame.next === next.length) { ordered.push(frame.id); stack.pop(); continue; }
      const key = next[frame.next++];
      if (!seen.has(key)) { seen.add(key); stack.push({id: key, next: 0}); }
    }
  }
  const component = new Map(), members = [];
  for (const id of ordered.reverse()) {
    if (component.has(id)) continue;
    const group = [], number = members.length, stack = [id]; component.set(id, number);
    while (stack.length) {
      const key = stack.pop(); group.push(key);
      // @ts-expect-error -- abapiti form pending
      for (const next of reverse.get(key)) if (!component.has(next)) { component.set(next, number); stack.push(next); }
    }
    members.push(group.sort());
  }
  const dependencies = members.map((group, number) => [...new Set(group.flatMap((id) =>
    // @ts-expect-error -- abapiti form pending
    edges.get(id).map((key) => component.get(key))).filter((key) => key !== number))]);
  return {component, members, dependencies};
}
