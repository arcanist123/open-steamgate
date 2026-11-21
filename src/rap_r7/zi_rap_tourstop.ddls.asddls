@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP tour stop demo (R7)'
define view entity ZI_RAP_TOURSTOP as select from zrap_tourstop
  association to parent ZI_RAP_TOUR as _Tour on $projection.tour_id = _Tour.tour_id
{
  key tour_id,
  key stop_no,
      place_name as place,
      nights,
      @Semantics.systemDateTime.localInstanceLastChangedAt: true
      stop_changed_at,
      _Tour
}
