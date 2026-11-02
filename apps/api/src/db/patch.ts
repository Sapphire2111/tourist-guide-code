/**
 * Есть ли в объекте хотя бы одно заданное (не undefined) поле. Kysely пропускает undefined-значения, а пустые
 * `INSERT ... () VALUES ()` и `UPDATE ... SET` — синтаксическая ошибка PostgreSQL (42601): репозитории
 * проверяют вход этой функцией.
 */
export function hasValues(obj: object): boolean {
  return Object.values(obj).some((v) => v !== undefined);
}
