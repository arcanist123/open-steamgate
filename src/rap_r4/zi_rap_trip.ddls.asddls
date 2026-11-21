@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP trip demo (R4)'
define root view entity ZI_RAP_TRIP as select from zrap_trip
{
  key trip_id,
      description,
      status,
      @Semantics.user.createdBy: true
      created_by,
      @Semantics.systemDateTime.localInstanceLastChangedAt: true
      last_changed_at
}
