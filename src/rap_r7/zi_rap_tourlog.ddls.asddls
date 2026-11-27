@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP tour change log (R7)'
define view entity ZI_RAP_TOURLOG as select from zrap_tourlog
{
  key log_id,
      tour_id,
      operation,
      field_name,
      new_value
}
