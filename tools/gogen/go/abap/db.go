package abap

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

// The database interface of the kernel. The Node side runs the same tables
// on SQLite through the transpiler's
// DatabaseClient; the Go host builds its own from the same inputs (the
// transpiler's CREATE TABLEs for the registry and test/seed.mjs's rows), so
// the two cannot drift.
//
// A Database is one opened database: the pool and the statement cache
// prepared on it. It belongs to the host (ADR 0010 slice 2): the host opens
// it, hands it to the Sessions that run on it (Session.DB, Instance) and
// closes it. Nothing in this package keeps a database in a package variable,
// so two databases in one process -- the Unit runner's image per test
// class, two hosts in one test binary -- never meet.
//
// In-memory SQLite is one database per connection, so the pool keeps one;
// a -db file keeps one too (icf_db.go), so a step holds the connection its
// transaction runs on and a second step on the same database is refused at
// begin rather than queued forever on the pool, and so is a statement
// outside a step while another session's step holds it (luw.go). A closed
// Database refuses steps and statements as CX_SY_OPEN_SQL_DB.
type Database struct {
	sql *sql.DB
	// the statement cache (luw.go), prepared on this database's connection
	stmtCache   map[string]*sql.Stmt
	stmtSeen    map[string]int
	stmtPending []string
	// inStep is the session whose dialog step holds the connection, nil
	// between steps
	inStep *Session
}

// newDatabase is the one place the pool is sized.
func newDatabase(d *sql.DB) *Database {
	d.SetMaxOpenConns(1)
	return &Database{sql: d, stmtCache: map[string]*sql.Stmt{}, stmtSeen: map[string]int{}}
}

// SQL is the pool itself, for a host that closes or inspects it; a
// statement of a step goes through the Session, never through this.
func (d *Database) SQL() *sql.DB { return d.sql }

// Close closes the prepared statements and the pool. Closing a WAL file
// checkpoints it. A step still open on it is not ended here: the host ends
// its steps first (serving: Quiesce under the work process).
func (d *Database) Close() error {
	if d == nil || d.sql == nil {
		return nil
	}
	for _, p := range d.stmtCache {
		p.Close()
	}
	clear(d.stmtCache)
	clear(d.stmtSeen)
	d.stmtPending = d.stmtPending[:0]
	s := d.sql
	d.sql = nil
	return s.Close()
}

// OpenDB creates the in-memory database and runs the script, a JSON array of
// SQL statements.
func OpenDB(script []byte) (*Database, error) {
	var stmts []string
	if err := json.Unmarshal(script, &stmts); err != nil {
		return nil, err
	}
	d, err := openSQL(":memory:")
	if err != nil {
		return nil, err
	}
	db := newDatabase(d)
	for i, st := range stmts {
		if _, execErr := d.Exec(st); execErr != nil {
			_ = d.Close()
			return nil, fmt.Errorf("statement %d: %w: %.200s", i, execErr, st)
		}
	}
	if err := prepareStore(d); err != nil {
		_ = d.Close()
		return nil, err
	}
	return db, nil
}

// Image copies the database into a portable in-memory image. The caller
// owns the returned bytes and may open them as independent databases
// (OpenDBImage).
func (d *Database) Image() ([]byte, error) {
	conn, err := d.sql.Conn(context.Background())
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	var image []byte
	err = conn.Raw(func(driver any) error {
		serializer, ok := driver.(interface{ Serialize() ([]byte, error) })
		if !ok {
			return fmt.Errorf("database driver cannot serialize")
		}
		image, err = serializer.Serialize()
		return err
	})
	return image, err
}

// OpenDBImage opens a writable copy of a seeded image as a database of its
// own (a test class's, in the Unit runner). SQLite allocates the image on
// this connection; later writes cannot affect the bytes held by the runner
// or another class's database.
func OpenDBImage(image []byte) (*Database, error) {
	d, err := openSQL(":memory:")
	if err != nil {
		return nil, err
	}
	conn, err := d.Conn(context.Background())
	if err != nil {
		_ = d.Close()
		return nil, err
	}
	err = conn.Raw(func(driver any) error {
		deserializer, ok := driver.(interface{ Deserialize([]byte) error })
		if !ok {
			return fmt.Errorf("database driver cannot deserialize")
		}
		return deserializer.Deserialize(image)
	})
	_ = conn.Close()
	if err != nil {
		_ = d.Close()
		return nil, err
	}
	db := newDatabase(d)
	if err := prepareStore(d); err != nil {
		_ = d.Close()
		return nil, err
	}
	return db, nil
}

// UseUnitImage gives a Unit test class's session its seed image without
// opening it: the first statement opens a private copy and begins the Unit
// LUW (database, below). Some ABAP calls reach SQL through dynamic
// dispatch, beyond the runner's static detection, and this is how such a
// class still gets a database of its own.
func (s *Session) UseUnitImage(image []byte) { s.unitImage = image }

// OpenUnitDB opens a test class's private copy of the seed image as the
// session's database, closing one it had, and begins the Unit LUW.
func (s *Session) OpenUnitDB(image []byte) error {
	d, err := OpenDBImage(image)
	if err != nil {
		return err
	}
	CloseUnitDB(s)
	s.DB = d
	BeginUnitLUW(s)
	return nil
}

// database is the session's database; a SELECT in a session the host gave
// none is a host error. A Unit session opens its image here on first use.
func (s *Session) database() *Database {
	if s.DB == nil {
		if s.unitImage != nil {
			d, err := OpenDBImage(s.unitImage)
			if err != nil {
				panic(err)
			}
			s.DB = d
			BeginUnitLUW(s)
			return d
		}
		panic(NotCompiled("database", "the host did not open a database"))
	}
	return s.DB
}

// CloseUnitDB releases the test class's database and its LUW. The seed
// image is kept by the runner, independently of this database.
func CloseUnitDB(s *Session) {
	if s.DB == nil {
		return
	}
	if s.tx != nil {
		s.end(false)
	}
	d := s.DB
	s.DB = nil
	_ = d.Close()
}

// ScriptImage runs a seed script on an in-memory database of its own and
// returns that database's image. No other database is touched: a serving
// host builds the image its ABAP Unit runs copy (Session.OpenUnitDB) beside
// the database it serves, and each test class's session opens its own copy.
func ScriptImage(script []byte) ([]byte, error) {
	d, err := OpenDB(script)
	if err != nil {
		return nil, err
	}
	defer d.Close()
	return d.Image()
}
