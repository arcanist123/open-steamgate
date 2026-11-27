@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP tour demo (R7)'
define root view entity ZI_RAP_TOUR as select from zrap_tour
  composition [0..*] of ZI_RAP_TOURSTOP as _Stops
{
  key tour_id,
      description,
      status,
      @Semantics.systemDateTime.lastChangedAt: true
      last_changed_at,
      _Stops
}
