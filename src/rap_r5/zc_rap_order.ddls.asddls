@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP order projection (R5)'
define root view entity ZC_RAP_ORDER provider contract transactional_query
  as projection on ZI_RAP_ORDER
{
  key order_id        as OrderId,
      description     as Description,
      status          as Status,
      created_by      as CreatedBy,
      last_changed_at as LastChangedAt,
      _Items : redirected to composition child ZC_RAP_ORDITEM
}
