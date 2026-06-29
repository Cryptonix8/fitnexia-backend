/**
 * Removes rows that block user / instructor / institution deletion.
 * Scoped to the given user only — other accounts are untouched.
 */

async function purgeClassesForCondition(client, sqlCondition, params) {
  await client.query(
    `DELETE FROM reviews r
     USING bookings b, classes c
     WHERE r.booking_id = b.id AND b.class_id = c.id AND ${sqlCondition}`,
    params,
  );

  await client.query(
    `DELETE FROM payout_ledger pl
     USING bookings b, classes c
     WHERE pl.booking_id = b.id AND b.class_id = c.id AND ${sqlCondition}`,
    params,
  );

  await client.query(
    `DELETE FROM notification_deliveries nd
     USING bookings b, classes c
     WHERE nd.booking_id = b.id AND b.class_id = c.id AND ${sqlCondition}`,
    params,
  );

  await client.query(
    `DELETE FROM bookings b
     USING classes c
     WHERE b.class_id = c.id AND ${sqlCondition}`,
    params,
  );

  await client.query(`DELETE FROM classes c WHERE ${sqlCondition}`, params);
}

async function purgeInstructorData(client, instructorId) {
  await client.query(`DELETE FROM reviews WHERE instructor_id = $1`, [instructorId]);
  await client.query(`DELETE FROM staff_reviews WHERE instructor_id = $1`, [instructorId]);
  await client.query(`DELETE FROM payout_ledger WHERE instructor_id = $1`, [instructorId]);
  await client.query(`DELETE FROM job_applications WHERE instructor_id = $1`, [instructorId]);
  await client.query(`DELETE FROM institution_instructors WHERE instructor_id = $1`, [
    instructorId,
  ]);
  await client.query(`DELETE FROM verification_requests WHERE instructor_id = $1`, [instructorId]);
  await purgeClassesForCondition(client, 'c.instructor_id = $1', [instructorId]);
}

async function purgeInstitutionData(client, institutionId) {
  await client.query(`DELETE FROM staff_reviews WHERE institution_id = $1`, [institutionId]);
  await client.query(`DELETE FROM payout_ledger WHERE institution_id = $1`, [institutionId]);
  await client.query(`DELETE FROM verification_requests WHERE institution_id = $1`, [
    institutionId,
  ]);
  await purgeClassesForCondition(client, 'c.institution_id = $1', [institutionId]);
  await client.query(`DELETE FROM institutions WHERE id = $1`, [institutionId]);
}

async function purgeAthleteData(client, userId) {
  await client.query(`DELETE FROM review_reports WHERE reporter_user_id = $1`, [userId]);
  await client.query(`DELETE FROM reviews WHERE athlete_user_id = $1`, [userId]);

  await client.query(
    `DELETE FROM payout_ledger pl
     USING bookings b
     WHERE pl.booking_id = b.id AND b.athlete_user_id = $1`,
    [userId],
  );

  await client.query(
    `DELETE FROM notification_deliveries nd
     USING bookings b
     WHERE nd.booking_id = b.id AND b.athlete_user_id = $1`,
    [userId],
  );

  await client.query(`DELETE FROM bookings WHERE athlete_user_id = $1`, [userId]);
}

/** Clears FK references to this user from tables without ON DELETE CASCADE. */
async function purgeUserReferences(client, userId) {
  await client.query(
    `UPDATE membership_invites SET accepted_by_user_id = NULL WHERE accepted_by_user_id = $1`,
    [userId],
  );
  await client.query(`UPDATE verification_requests SET reviewed_by = NULL WHERE reviewed_by = $1`, [
    userId,
  ]);
  await client.query(`UPDATE reviews SET removed_by = NULL WHERE removed_by = $1`, [userId]);
  await client.query(`DELETE FROM staff_reviews WHERE author_user_id = $1`, [userId]);
  await client.query(`DELETE FROM review_reports WHERE reporter_user_id = $1`, [userId]);
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 */
async function purgeUserRelatedData(client, userId) {
  const { rows } = await client.query(`SELECT id, role FROM users WHERE id = $1`, [userId]);
  if (!rows.length) return;

  const { role } = rows[0];

  if (role === 'instructor') {
    const { rows: instructors } = await client.query(
      `SELECT id FROM instructors WHERE user_id = $1`,
      [userId],
    );
    for (const row of instructors) {
      await purgeInstructorData(client, row.id);
    }
  }

  if (role === 'institution') {
    const { rows: institutions } = await client.query(
      `SELECT id FROM institutions WHERE user_id = $1`,
      [userId],
    );
    for (const row of institutions) {
      await purgeInstitutionData(client, row.id);
    }
  }

  if (role === 'athlete') {
    await purgeAthleteData(client, userId);
  }

  await purgeUserReferences(client, userId);
}

module.exports = {
  purgeUserRelatedData,
  purgeInstructorData,
  purgeInstitutionData,
  purgeAthleteData,
};
