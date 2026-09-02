/** pgvector 向量序列化：Float32Array/数组 → "[0.1,0.2,...]" 文本（pgvector 要求） */
export function vectorToPg(vec: number[] | Float32Array): string {
  return `[${Array.from(vec).join(',')}]`;
}
