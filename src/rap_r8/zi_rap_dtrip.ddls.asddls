@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP draft trip demo (R8)'
define root view entity ZI_RAP_DTRIP as select from zrap_dtrip
  composition [0..*] of ZI_RAP_DLEG as _Legs
{
  key trip_uuid,
      description,
      status,
      @Semantics.systemDateTime.lastChangedAt: true
      last_changed_at,
      @Semantics.systemDateTime.localInstanceLastChangedAt: true
      local_changed_at,
      _Legs
}
