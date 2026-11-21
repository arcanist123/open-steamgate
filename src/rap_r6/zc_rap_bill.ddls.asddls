@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP bill projection (R6)'
define root view entity ZC_RAP_BILL provider contract transactional_query
  as projection on ZI_RAP_BILL
{
  key bill_id     as BillId,
      description as Description,
      amount      as Amount,
      discount    as Discount,
      total       as Total,
      checks      as Checks,
      copied_from as CopiedFrom
}
