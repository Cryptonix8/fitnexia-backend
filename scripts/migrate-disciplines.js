const { pool } = require('../src/db/pool');
const { normalizeDiscipline, normalizeDisciplineList } = require('../src/config/disciplines');

async function migrateDisciplineArray(rows, column, idColumn = 'id') {
  let updated = 0;
  for (const row of rows) {
    const current = row[column] || [];
    const next = normalizeDisciplineList(current);
    const changed =
      current.length !== next.length || current.some((value, index) => value !== next[index]);
    if (!changed) continue;

    await pool.query(`UPDATE ${row.table} SET ${column} = $1 WHERE ${idColumn} = $2`, [
      next,
      row[idColumn],
    ]);
    updated += 1;
  }
  return updated;
}

async function main() {
  const classes = await pool.query(`SELECT id, discipline FROM classes`);
  let classUpdates = 0;
  for (const row of classes.rows) {
    const next = normalizeDiscipline(row.discipline);
    if (next === row.discipline) continue;
    await pool.query(`UPDATE classes SET discipline = $1 WHERE id = $2`, [next, row.id]);
    classUpdates += 1;
  }

  const instructors = await pool.query(`SELECT id, disciplines FROM instructors`);
  const instructorUpdates = await migrateDisciplineArray(
    instructors.rows.map((row) => ({ ...row, table: 'instructors' })),
    'disciplines',
  );

  const athletes = await pool.query(`SELECT user_id, favorite_sports FROM athlete_profiles`);
  const athleteUpdates = await migrateDisciplineArray(
    athletes.rows.map((row) => ({ ...row, table: 'athlete_profiles' })),
    'favorite_sports',
    'user_id',
  );

  console.log(
    `Migrated disciplines — classes: ${classUpdates}, instructors: ${instructorUpdates}, athletes: ${athleteUpdates}`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
