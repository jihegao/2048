let generation = 0;

export function currentAuthGeneration(): number {
  return generation;
}

export function advanceAuthGeneration(): number {
  generation += 1;
  return generation;
}
