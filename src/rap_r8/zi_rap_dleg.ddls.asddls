@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP draft trip leg demo (R8)'
define view entity ZI_RAP_DLEG as select from zrap_dleg
  association to parent ZI_RAP_DTRIP as _Trip on $projection.trip_uuid = _Trip.trip_uuid
{
  key leg_uuid,
      trip_uuid,
      destination,
      @Semantics.systemDateTime.localInstanceLastChangedAt: true
      leg_changed_at,
      _Trip
}
