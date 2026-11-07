const list=value=>Array.isArray(value)?value:[];
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);

/** Completion is canonical return verification, never the UI display label.
 * Cancelled work belongs to neither pending work nor successful completion.
 * Unknown or unverified legacy records remain visible as unfinished work.
 */
export function driverTripCompletion(trip){
 const status=typeof trip?.status==='string'?trip.status.toLowerCase():'';
 if(status==='cancelled')return 'cancelled';
 if(status==='returned'||status==='completed'&&validId(trip.returnVerifiedBy))return 'completed';
 return 'unfinished';
}

/** Input must already be scoped to the current Driver by the canonical view. */
export function filterDriverTrips(trips,filter='unfinished'){
 const selected=filter==='completed'?'completed':'unfinished';
 return list(trips).filter(trip=>trip&&typeof trip==='object'&&driverTripCompletion(trip)===selected);
}
