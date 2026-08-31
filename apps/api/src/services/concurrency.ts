export async function mapSettledWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<TResult>,
): Promise<PromiseSettledResult<TResult>[]> {
  if (values.length === 0) return [];
  const results = new Array<PromiseSettledResult<TResult>>(values.length);
  let nextIndex = 0;
  const workerCount = Math.max(
    1,
    Math.min(values.length, Math.floor(concurrency)),
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await task(values[index]!, index),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const settled = await mapSettledWithConcurrency(
    values,
    concurrency,
    task,
  );
  const failed = settled.find(
    (result): result is PromiseRejectedResult =>
      result.status === 'rejected',
  );
  if (failed) throw failed.reason;
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
