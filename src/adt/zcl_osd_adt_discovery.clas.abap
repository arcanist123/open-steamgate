"! Discovery is static protocol data in advertise() order, independent of STORE.
"! Changes to Node advertise() calls must update COLLECTIONS in the same change.
"! The permanent discovery diff cases guard both lists, including byte quirks.
CLASS zcl_osd_adt_discovery DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_osd_adt_route.
    TYPES: BEGIN OF ty_link,
             rel TYPE string,
             template TYPE string,
             content_type TYPE string,
           END OF ty_link.
    TYPES tt_link TYPE STANDARD TABLE OF ty_link WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_collection,
             adt TYPE string,
             title TYPE string,
             workspace TYPE string,
             accept TYPE string_table,
             term TYPE string,
             scheme TYPE string,
             links TYPE tt_link,
           END OF ty_collection.
    TYPES tt_collection TYPE STANDARD TABLE OF ty_collection WITH DEFAULT KEY.
    CLASS-METHODS collections RETURNING VALUE(rt_collections) TYPE tt_collection.
    "! iv_core: the core/discovery form, one collection per workspace. The
    "! same collections, but a client's reader of core discovery (abap-adt-api
    "! adtCoreDiscovery, which DebugService.create calls first) takes
    "! app:collection as one element per workspace and fails on a list.
    CLASS-METHODS document IMPORTING iv_core TYPE abap_bool DEFAULT abap_false RETURNING VALUE(rv_xml) TYPE string.
  PRIVATE SECTION.
    CLASS-METHODS source_collections CHANGING ct_collections TYPE tt_collection.
    CLASS-METHODS loop_collections CHANGING ct_collections TYPE tt_collection.
    CLASS-METHODS package_collections CHANGING ct_collections TYPE tt_collection.
    CLASS-METHODS repository_collections CHANGING ct_collections TYPE tt_collection.
    CLASS-METHODS preview_collections CHANGING ct_collections TYPE tt_collection.
    CLASS-METHODS collection_xml
      IMPORTING is_collection TYPE ty_collection
      RETURNING VALUE(rv_xml) TYPE string.
ENDCLASS.

CLASS zcl_osd_adt_discovery IMPLEMENTATION.
  METHOD zif_osd_adt_route~handle.
*   The form follows the row that matched (the pattern dispatch sets), not
*   the raw path: a HEAD falling back to a GET row is that GET, so HEAD
*   core/discovery keeps the core form's headers, as a system's HEAD does.
    DATA lv_route TYPE string.
    lv_route = is_request-pattern.
    IF lv_route IS INITIAL.
      lv_route = is_request-path.
    ENDIF.
    rs_response-status = 200.
    IF is_request-method = `HEAD`.
      rs_response-content_type = `application/atomsvc+xml`.
      RETURN.
    ENDIF.
    rs_response-content_type = `application/atomsvc+xml; charset=utf-8`.
    rs_response-body = document( boolc( to_lower( lv_route ) CS `/core/discovery` ) ).
  ENDMETHOD.

  METHOD collections.
    source_collections( CHANGING ct_collections = rt_collections ).
    loop_collections( CHANGING ct_collections = rt_collections ).
    package_collections( CHANGING ct_collections = rt_collections ).
    repository_collections( CHANGING ct_collections = rt_collections ).
    preview_collections( CHANGING ct_collections = rt_collections ).
  ENDMETHOD.

  METHOD source_collections.
    DATA ls_collection TYPE ty_collection.
    DATA ls_link TYPE ty_link.
    CLEAR ls_collection.
    ls_collection-adt = `repository/informationsystem/virtualfolders`.
    ls_collection-title = `repository/informationsystem/virtualfolders`.
    ls_collection-workspace = `Repository`.
    ls_collection-term = `virtualfolders`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/repository`.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `repository/informationsystem/objecttypes`.
    ls_collection-title = `repository/informationsystem/objecttypes`.
    ls_collection-workspace = `Repository`.
    ls_collection-term = `objecttypes`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/respository`.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `repository/informationsystem/releasestates`.
    ls_collection-title = `repository/informationsystem/releasestates`.
    ls_collection-workspace = `Repository`.
    ls_collection-term = `releasestates`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/respository`.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `abapunit/metadata`.
    ls_collection-title = `abapunit/metadata`.
    ls_collection-workspace = `Development Loop`.
    ls_collection-term = `metadata`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/abapunit`.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `oo/classes`.
    ls_collection-title = `Classes`.
    ls_collection-workspace = `Source Library`.
    ls_collection-term = `classes`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/oo`.
    APPEND `application/vnd.sap.adt.oo.classes.v4+xml` TO ls_collection-accept.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `oo/interfaces`.
    ls_collection-title = `Interfaces`.
    ls_collection-workspace = `Source Library`.
    ls_collection-term = `interfaces`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/oo`.
    APPEND `application/vnd.sap.adt.oo.interfaces.v2+xml` TO ls_collection-accept.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `programs/programs`.
    ls_collection-title = `Programs`.
    ls_collection-workspace = `Source Library`.
    ls_collection-term = `programs`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/programs`.
    APPEND `application/vnd.sap.adt.programs.programs.v2+xml` TO ls_collection-accept.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `ddic/ddl/sources`.
    ls_collection-title = `CDS DDL Sources`.
    ls_collection-workspace = `Data Dictionary`.
    ls_collection-term = `ddlsources`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/ddic/ddlsources`.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/ddic/ddlsources/properties`.
    ls_link-template = `/sap/bc/adt/ddic/ddl/sources/{object_name}{?corrNr,lockHandle,version,accessMode,_action}`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/ddic/ddlsources/source`.
    ls_link-template = `/sap/bc/adt/ddic/ddl/sources/{object_name}/source/main{?corrNr,lockHandle,version}`.
    APPEND ls_link TO ls_collection-links.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `ddic/srvd/sources`.
    ls_collection-title = `Service Definitions`.
    ls_collection-workspace = `Data Dictionary`.
    ls_collection-term = `srvdsrv`.
    ls_collection-scheme = `http://www.sap.com/wbobj/raps`.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/wbobj/raps/srvdsrv/properties`.
    ls_link-template = `/sap/bc/adt/ddic/srvd/sources/{object_name}{?corrNr,lockHandle,version,accessMode,_action}`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/wbobj/raps/srvdsrv/source`.
    ls_link-template = `/sap/bc/adt/ddic/srvd/sources/{object_name}/source/main{?corrNr,lockHandle,version}`.
    APPEND ls_link TO ls_collection-links.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `programs/includes`.
    ls_collection-title = `Includes`.
    ls_collection-workspace = `Source Library`.
    ls_collection-term = `includes`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/programs`.
    APPEND `application/vnd.sap.adt.programs.includes.v2+xml` TO ls_collection-accept.
    APPEND ls_collection TO ct_collections.

  ENDMETHOD.

  METHOD loop_collections.
    DATA ls_collection TYPE ty_collection.
    DATA ls_link TYPE ty_link.
    CLEAR ls_collection.
    ls_collection-adt = `oo/classrun`.
    ls_collection-title = `Run a class`.
    ls_collection-workspace = `Source Library`.
    ls_collection-term = `classrun`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/oo`.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/relations/oo/classrun`.
    ls_link-template = `/sap/bc/adt/oo/classrun/{classname}{?profilerId}`.
    ls_link-content_type = `text/plain`.
    APPEND ls_link TO ls_collection-links.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `checkruns`.
    ls_collection-title = `Check Runs (syntax)`.
    ls_collection-workspace = `Development Loop`.
    ls_collection-term = `checkruns`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/check`.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/check/relations/reporters`.
    ls_link-template = `/sap/bc/adt/checkruns{?reporters}`.
    APPEND ls_link TO ls_collection-links.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `cts/transportchecks`.
    ls_collection-title = `Transport Checks`.
    ls_collection-workspace = `Development Loop`.
    ls_collection-term = `transportchecks`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/cts`.
    APPEND `application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData` TO ls_collection-accept.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `checkruns/reporters`.
    ls_collection-title = `checkruns/reporters`.
    ls_collection-workspace = `Source Library`.
    ls_collection-term = `reporters`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/check`.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `activation/inactiveobjects`.
    ls_collection-title = `activation/inactiveobjects`.
    ls_collection-workspace = `Source Library`.
    ls_collection-term = `inactiveobjects`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/activation`.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/relations/activation/inactiveobjects`.
    ls_link-template = `/sap/bc/adt/activation/inactiveobjects{?USERNAME}`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/relations/activation/inactiveobjects/update`.
    ls_link-template = `/sap/bc/adt/activation/inactiveobjects{?action}`.
    APPEND ls_link TO ls_collection-links.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `activation`.
    ls_collection-title = `Activation`.
    ls_collection-workspace = `Development Loop`.
    ls_collection-term = `activationruns`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/activation`.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `abapunit/testruns`.
    ls_collection-title = `ABAP Unit Test Runs`.
    ls_collection-workspace = `Development Loop`.
    ls_collection-term = `unittestruns`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/abapunit`.
    APPEND `application/vnd.sap.adt.abapunit.testruns.config.v1+xml` TO ls_collection-accept.
    APPEND `application/vnd.sap.adt.abapunit.testruns.config.v2+xml` TO ls_collection-accept.
    APPEND `application/vnd.sap.adt.abapunit.testruns.config.v3+xml` TO ls_collection-accept.
    APPEND `application/vnd.sap.adt.abapunit.testruns.config.v4+xml` TO ls_collection-accept.
    APPEND `application/xml` TO ls_collection-accept.
    APPEND ls_collection TO ct_collections.


  ENDMETHOD.

  METHOD package_collections.
    DATA ls_collection TYPE ty_collection.
    DATA ls_link TYPE ty_link.
    CLEAR ls_collection.
    ls_collection-adt = `packages`.
    ls_collection-title = `Packages`.
    ls_collection-workspace = `Repository`.
    ls_collection-term = `devck`.
    ls_collection-scheme = `http://www.sap.com/wbobj/packages`.
    APPEND `application/vnd.sap.adt.packages.v2+xml` TO ls_collection-accept.
    APPEND `application/vnd.sap.adt.packages.v1+xml` TO ls_collection-accept.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/wbobj/packages/devck/properties`.
    ls_link-template = `/sap/bc/adt/packages/{object_name}{?corrNr,lockHandle,version,accessMode,_action}`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `applicationcomponents`.
    ls_link-template = `/sap/bc/adt/packages/valuehelps/applicationcomponents`.
    ls_link-content_type = `application/vnd.sap.adt.nameditems.v1+xml`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `softwarecomponents`.
    ls_link-template = `/sap/bc/adt/packages/valuehelps/softwarecomponents`.
    ls_link-content_type = `application/vnd.sap.adt.nameditems.v1+xml`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `transportlayers`.
    ls_link-template = `/sap/bc/adt/packages/valuehelps/transportlayers`.
    ls_link-content_type = `application/vnd.sap.adt.nameditems.v1+xml`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `translationrelevances`.
    ls_link-template = `/sap/bc/adt/packages/valuehelps/translationrelevances`.
    ls_link-content_type = `application/vnd.sap.adt.nameditems.v1+xml`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `abaplanguageversions`.
    ls_link-template = `/sap/bc/adt/packages/valuehelps/abaplanguageversions`.
    ls_link-content_type = `application/vnd.sap.adt.nameditems.v1+xml`.
    APPEND ls_link TO ls_collection-links.
    APPEND ls_collection TO ct_collections.
    CLEAR ls_collection.
    ls_collection-adt = `packages/validation`.
    ls_collection-title = `Package Name Validation`.
    ls_collection-workspace = `Repository`.
    ls_collection-term = `devck/validation`.
    ls_collection-scheme = `http://www.sap.com/wbobj/packages`.
    APPEND ls_collection TO ct_collections.
    CLEAR ls_collection.
    ls_collection-adt = `packages/settings`.
    ls_collection-title = `Package Settings`.
    ls_collection-workspace = `Repository`.
    ls_collection-term = `settings`.
    ls_collection-scheme = `http://www.sap.com/wbobj/packages`.
    APPEND ls_collection TO ct_collections.
    CLEAR ls_collection.
    ls_collection-adt = `oo/validation/objectname`.
    ls_collection-title = `Validation of Object Name`.
    ls_collection-workspace = `Source Library`.
    ls_collection-term = `validation`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/oo`.
    APPEND ls_collection TO ct_collections.


  ENDMETHOD.

  METHOD repository_collections.
    DATA ls_collection TYPE ty_collection.
    DATA ls_link TYPE ty_link.
    CLEAR ls_collection.
    ls_collection-adt = `ddic/dataelements`.
    ls_collection-title = `Data Element`.
    ls_collection-workspace = `Data Dictionary`.
    ls_collection-term = `dtelde`.
    ls_collection-scheme = `http://www.sap.com/wbobj/dictionary`.
    APPEND `application/vnd.sap.adt.dataelements.v2+xml` TO ls_collection-accept.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/wbobj/dictionary/dtelde/properties`.
    ls_link-template = `/sap/bc/adt/ddic/dataelements/{object_name}{?corrNr,lockHandle,version,accessMode,_action}`.
    APPEND ls_link TO ls_collection-links.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `repository/nodestructure`.
    ls_collection-title = `Repository Node Structure`.
    ls_collection-workspace = `Repository`.
    ls_collection-term = `nodestructure`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/respository`.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `repository/informationsystem/search`.
    ls_collection-title = `Object Search`.
    ls_collection-workspace = `Repository`.
    ls_collection-term = `search`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/respository`.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/relations/informationsystem/search/quicksearch`.
    ls_link-template = `/sap/bc/adt/repository/informationsystem/search{?operation,query,useSearchProvider,noDescription,maxResults}{&objectType`
      && `*}{&group*}{&packageName*}{&sourcetype*}{&state*}{&lifecycle*}{&rollout*}{&category*}{&appl*}{&userName*}{&releaseState*`
      && `}{&language*}{&system*}{&version*}{&docu*}{&fav*}{&created*}{&month*}{&date*}{&comp*}`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/relations/informationsystem/search/whitelisting`.
    ls_link-template = `/sap/bc/adt/repository/informationsystem/search{?operation,query,useSearchProvider,noDescription,maxResults}{&objectType`
      && `*}{&group*}{&packageName*}{&sourcetype*}{&state*}{&lifecycle*}{&rollout*}{&category*}{&appl*}{&userName*}{&releaseState*`
      && `}{&language*}{&system*}{&version*}{&docu*}{&fav*}{&created*}{&month*}{&date*}{&comp*}`.
    APPEND ls_link TO ls_collection-links.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `ddic/tables`.
    ls_collection-title = `Database Table`.
    ls_collection-workspace = `Data Dictionary`.
    ls_collection-term = `tabldt`.
    ls_collection-scheme = `http://www.sap.com/wbobj/dictionary`.
    APPEND `application/vnd.sap.adt.tables.v2+xml` TO ls_collection-accept.
    APPEND ls_collection TO ct_collections.

  ENDMETHOD.

  METHOD preview_collections.
    DATA ls_collection TYPE ty_collection.
    DATA ls_link TYPE ty_link.
    CLEAR ls_collection.
    ls_collection-adt = `datapreview/ddic`.
    ls_collection-title = `Modelled Data Preview for DDIC`.
    ls_collection-workspace = `Data Dictionary`.
    ls_collection-term = `DatapreviewDdic`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/datapreview`.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/datapreview/ddic/metadata`.
    ls_link-template = `/sap/bc/adt/datapreview/ddic/{object_name}/metadata`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/datapreview/ddic`.
    ls_link-template = `/sap/bc/adt/datapreview/ddic{?rowNumber,ddicEntityName}`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/datapreview/ddic/colcount`.
    ls_link-template = `/sap/bc/adt/datapreview/ddic{?rowNumber,ddicEntityName,colNumber}`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/datapreview/ddic/launchfreestyle`.
    ls_link-template = `/sap/bc/adt/datapreview/freestyle`.
    APPEND ls_link TO ls_collection-links.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `datapreview/cds`.
    ls_collection-title = `Data Preview for CDS`.
    ls_collection-workspace = `Data Dictionary`.
    ls_collection-term = `DatapreviewCds`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/datapreview`.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/datapreview/cds/metadata`.
    ls_link-template = `/sap/bc/adt/datapreview/cds/{object_name}/metadata`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/datapreview/cds`.
    ls_link-template = `/sap/bc/adt/datapreview/cds{?rowNumber,ddlSourceName}`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/datapreview/cds/associationrefresh`.
    ls_link-template = `/sap/bc/adt/datapreview/cds{?action,rowNumber,targetType,ddlSourceName}`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/datapreview/cds/launchfreestyle`.
    ls_link-template = `/sap/bc/adt/datapreview/cds`.
    APPEND ls_link TO ls_collection-links.
    APPEND ls_collection TO ct_collections.

    CLEAR ls_collection.
    ls_collection-adt = `datapreview/freestyle`.
    ls_collection-title = `Data Preview (freestyle SQL)`.
    ls_collection-workspace = `Data Dictionary`.
    ls_collection-term = `DatapreviewFreeStyle`.
    ls_collection-scheme = `http://www.sap.com/adt/categories/datapreview`.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/datapreview/freestyle`.
    ls_link-template = `/sap/bc/adt/datapreview/freestyle{?rowNumber}`.
    APPEND ls_link TO ls_collection-links.
    CLEAR ls_link.
    ls_link-rel = `http://www.sap.com/adt/categories/datapreview/freestyle/check`.
    ls_link-template = `/sap/bc/adt/datapreview/freestyle{?action,uniqueURI}`.
    APPEND ls_link TO ls_collection-links.
    APPEND ls_collection TO ct_collections.

  ENDMETHOD.

  METHOD collection_xml.
    DATA lv_nl TYPE string.
    DATA lv_accept TYPE string.
    DATA ls_link TYPE ty_link.
    lv_nl = cl_abap_char_utilities=>newline.
    rv_xml = `    <app:collection href="/sap/bc/adt/` && zcl_osd_adt_xml=>esc( is_collection-adt ) && `">` && lv_nl
      && `      <atom:title>` && zcl_osd_adt_xml=>esc( is_collection-title ) && `</atom:title>` && lv_nl.
    LOOP AT is_collection-accept INTO lv_accept.
      rv_xml = rv_xml && `      <app:accept>` && zcl_osd_adt_xml=>esc( lv_accept ) && `</app:accept>` && lv_nl.
    ENDLOOP.
    rv_xml = rv_xml && `      <atom:category term="` && zcl_osd_adt_xml=>esc( is_collection-term )
      && `" scheme="` && zcl_osd_adt_xml=>esc( is_collection-scheme ) && `"/>` && lv_nl.
    IF is_collection-links IS INITIAL.
      rv_xml = rv_xml && `      <adtcomp:templateLinks/>` && lv_nl.
    ELSE.
      rv_xml = rv_xml && `      <adtcomp:templateLinks>` && lv_nl.
      LOOP AT is_collection-links INTO ls_link.
        rv_xml = rv_xml && `        <adtcomp:templateLink rel="` && zcl_osd_adt_xml=>esc( ls_link-rel )
          && `" template="` && zcl_osd_adt_xml=>esc( ls_link-template ) && `"`.
        IF ls_link-content_type IS NOT INITIAL.
          rv_xml = rv_xml && ` type="` && zcl_osd_adt_xml=>esc( ls_link-content_type ) && `"`.
        ENDIF.
        rv_xml = rv_xml && `/>` && lv_nl.
      ENDLOOP.
      rv_xml = rv_xml && `      </adtcomp:templateLinks>` && lv_nl.
    ENDIF.
    rv_xml = rv_xml && `    </app:collection>` && lv_nl.
  ENDMETHOD.

  METHOD document.
    DATA lt_collections TYPE tt_collection.
    DATA ls_collection TYPE ty_collection.
    DATA lt_workspaces TYPE string_table.
    DATA lv_workspace TYPE string.
    DATA lv_nl TYPE string.
    lv_nl = cl_abap_char_utilities=>newline.
    lt_collections = collections( ).
*   Group by first appearance; never sort the advertised list.
    LOOP AT lt_collections INTO ls_collection.
      READ TABLE lt_workspaces WITH KEY table_line = ls_collection-workspace TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        APPEND ls_collection-workspace TO lt_workspaces.
      ENDIF.
    ENDLOOP.
    rv_xml = `<?xml version="1.0" encoding="utf-8"?>` && lv_nl
      && `<app:service xmlns:app="http://www.w3.org/2007/app"` && lv_nl
      && `             xmlns:atom="http://www.w3.org/2005/Atom"` && lv_nl
      && `             xmlns:adtcomp="http://www.sap.com/adt/compatibility">` && lv_nl.
    LOOP AT lt_workspaces INTO lv_workspace.
      IF iv_core = abap_false.
        rv_xml = rv_xml && `  <app:workspace>` && lv_nl
          && `    <atom:title>` && zcl_osd_adt_xml=>esc( lv_workspace ) && `</atom:title>` && lv_nl.
      ENDIF.
      LOOP AT lt_collections INTO ls_collection WHERE workspace = lv_workspace.
        IF iv_core = abap_true.
          rv_xml = rv_xml && `  <app:workspace>` && lv_nl
            && `    <atom:title>` && zcl_osd_adt_xml=>esc( lv_workspace ) && `</atom:title>` && lv_nl
            && collection_xml( ls_collection ) && `  </app:workspace>` && lv_nl.
        ELSE.
          rv_xml = rv_xml && collection_xml( ls_collection ).
        ENDIF.
      ENDLOOP.
      IF iv_core = abap_false.
        rv_xml = rv_xml && `  </app:workspace>` && lv_nl.
      ENDIF.
    ENDLOOP.
    rv_xml = rv_xml && `</app:service>` && lv_nl.
  ENDMETHOD.
ENDCLASS.
