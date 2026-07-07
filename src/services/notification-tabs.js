/** Maps notification types to mobile tab keys per role. */
const TAB_BY_TYPE = {
  athlete: {
    class_scheduled: 'bookings',
    booking_confirmed: 'bookings',
    payment_confirmed: 'bookings',
    class_reminder_24h: 'bookings',
    class_reminder_1h: 'bookings',
    class_reminder_10m: 'bookings',
    class_ended: 'bookings',
    review_invite: 'bookings',
    class_cancelled_by_instructor: 'bookings',
    class_updated_by_instructor: 'bookings',
    series_paused: 'bookings',
    series_deleted: 'bookings',
    waitlist_spot: 'bookings',
    membership_invite: 'profile',
    membership_due_reminder: 'profile',
    membership_payment_confirmed: 'profile',
    membership_payment_failed: 'profile',
    membership_overdue: 'profile',
    verification_approved: 'profile',
    verification_rejected: 'profile',
    class_posted: 'search',
  },
  instructor: {
    class_posted: 'classes',
    booking_confirmed: 'dashboard',
    class_scheduled: 'dashboard',
    class_ended: 'calendar',
    class_reminder_24h: 'calendar',
    class_reminder_1h: 'calendar',
    class_reminder_10m: 'calendar',
    class_cancelled_by_instructor: 'classes',
    class_updated_by_instructor: 'classes',
    series_paused: 'classes',
    series_deleted: 'classes',
    payment_confirmed: 'earnings',
    instructor_invite: 'dashboard',
    verification_approved: 'profile',
    verification_rejected: 'profile',
    review_invite: 'profile',
  },
  institution: {
    class_posted: 'classes',
    booking_confirmed: 'dashboard',
    class_scheduled: 'dashboard',
    class_ended: 'calendar',
    instructor_invite: 'instructors',
    club_arrears_alert: 'members',
    membership_due_reminder: 'members',
    membership_payment_confirmed: 'members',
    membership_payment_failed: 'members',
    membership_overdue: 'members',
    verification_approved: 'profile',
    verification_rejected: 'profile',
  },
};

function tabForNotification(type, role, explicitTab) {
  if (explicitTab) return explicitTab;
  const roleKey = role === 'institution' ? 'institution' : role;
  return TAB_BY_TYPE[roleKey]?.[type] || null;
}

module.exports = { tabForNotification, TAB_BY_TYPE };
