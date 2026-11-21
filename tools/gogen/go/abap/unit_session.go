package abap

import (
	"osg/gogen/amc"
	"osg/gogen/session"
)

// EndTestClass releases session-owned resources before the next test class.
func EndTestClass(s *Session) {
	CloseUnitDB(s)
	for _, client := range s.httpc {
		client.drop()
	}
	s.httpc = nil
	if s.inflate != nil {
		s.inflate.DropAll()
		s.inflate = nil
	}
	CloseSessionDatasets(s)
	amc.Current().Forget(s)
	session.EndTestClass()
}
