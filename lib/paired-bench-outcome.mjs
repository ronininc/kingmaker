const finite = (value) => typeof value === 'number' && Number.isFinite(value);

export function assessPairedBench(rows, { expectedMedian, expectedJev } = {}) {
  const failures = [];
  if (!Array.isArray(rows) || rows.length !== 6) {
    failures.push(`expected exactly 6 turns, got ${Array.isArray(rows) ? rows.length : 'non-array'}`);
    return { pass: false, failures, totals: { modelCalls: 0 } };
  }
  let modelCalls = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? {};
    const expectedArm = index % 2 === 0 ? 'median' : 'jev';
    if (row.step !== index) failures.push(`turn ${index}: step must equal ${index}`);
    if (row.arm !== expectedArm) failures.push(`turn ${index}: expected ${expectedArm} arm`);
    if (row.error) failures.push(`turn ${index}: ${row.error}`);
    if (!finite(row.elapsed_s) || row.elapsed_s < 0) failures.push(`turn ${index}: missing elapsed_s`);
    if (!finite(row.peak_memory_mb) || row.peak_memory_mb < 0) failures.push(`turn ${index}: missing peak_memory_mb`);
    if (!finite(row.swap_delta_mb)) failures.push(`turn ${index}: missing swap_delta_mb`);
    if (!Number.isInteger(row.model_calls) || row.model_calls < 1) failures.push(`turn ${index}: model_calls must include all parent and child calls`);
    else modelCalls += row.model_calls;
    if (expectedArm === 'median') {
      if (expectedMedian && row.model !== expectedMedian) failures.push(`turn ${index}: median model mismatch`);
      if (typeof row.response !== 'string' || row.response.trim() === '') failures.push(`turn ${index}: median response missing`);
    } else {
      if (expectedJev && row.model !== expectedJev) failures.push(`turn ${index}: JEV model mismatch`);
      if (!finite(row.score)) failures.push(`turn ${index}: numeric JEV head score missing`);
      if (row.scored_through_head !== true) failures.push(`turn ${index}: JEV score was not proven through the head`);
    }
    if (!Array.isArray(row.loaded_after)) failures.push(`turn ${index}: loaded_after inventory missing`);
  }
  return { pass: failures.length === 0, failures, totals: { modelCalls } };
}

export function parseJsonl(text) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`invalid JSON on row ${index + 1}: ${error.message}`); }
  });
}
