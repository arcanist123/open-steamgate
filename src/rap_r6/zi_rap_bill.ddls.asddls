@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP bill demo (R6)'
define root view entity ZI_RAP_BILL as select from zrap_bill
{
  key bill_id,
      description,
      amount,
      discount,
      total,
      checks,
      copied_from
}
