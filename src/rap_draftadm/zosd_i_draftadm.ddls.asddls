@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP draft administrative data (R9)'
// The draft administrative data a draft-enabled service serves as
// DraftAdministrativeData (docs/rap-runtime.md, R9): one row per draft of a
// root, ZOSD_DRAFT_ADM, under the element names of the public RAP/Fiori
// draft protocol. The *ByMe flags and the user descriptions are not columns:
// ZCL_OSD_DRAFT_ADM_CALC fills them for the request's user (ZCL_OSD_LOGON).
define view entity ZOSD_I_DRAFTADM as select from zosd_draft_adm
{
  key draftuuid          as DraftUUID,
      draftentitytype    as DraftEntityType,
      creationdatetime   as CreationDateTime,
      createdbyuser      as CreatedByUser,
      lastchangedatetime as LastChangeDateTime,
      lastchangedbyuser  as LastChangedByUser,
      inprocessbyuser    as InProcessByUser,
      @ObjectModel.virtualElement: true
      @ObjectModel.virtualElementCalculatedBy: 'ABAP:ZCL_OSD_DRAFT_ADM_CALC'
      cast( '' as abap.char( 12 ) ) as CreatedByUserDescription,
      @ObjectModel.virtualElement: true
      @ObjectModel.virtualElementCalculatedBy: 'ABAP:ZCL_OSD_DRAFT_ADM_CALC'
      cast( '' as abap.char( 12 ) ) as LastChangedByUserDescription,
      @ObjectModel.virtualElement: true
      @ObjectModel.virtualElementCalculatedBy: 'ABAP:ZCL_OSD_DRAFT_ADM_CALC'
      cast( '' as abap.char( 12 ) ) as InProcessByUserDescription,
      @ObjectModel.virtualElement: true
      @ObjectModel.virtualElementCalculatedBy: 'ABAP:ZCL_OSD_DRAFT_ADM_CALC'
      cast( '' as abap.char( 1 ) ) as DraftIsCreatedByMe,
      @ObjectModel.virtualElement: true
      @ObjectModel.virtualElementCalculatedBy: 'ABAP:ZCL_OSD_DRAFT_ADM_CALC'
      cast( '' as abap.char( 1 ) ) as DraftIsLastChangedByMe,
      @ObjectModel.virtualElement: true
      @ObjectModel.virtualElementCalculatedBy: 'ABAP:ZCL_OSD_DRAFT_ADM_CALC'
      cast( '' as abap.char( 1 ) ) as DraftIsProcessedByMe
}
