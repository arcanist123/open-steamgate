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
// In-memory SQLite is one database per connection, so the pool keeps one.
// The Unit runner replaces this connection for every DB-using test class.
var db *sql.DB
var unitDBImage []byte

// SetUnitDBImage lets a Unit class open its seed copy on first SQL use.
// Some ABAP calls reach SQL through dynamic dispatch, beyond static detection.
func SetUnitDBImage(image []byte) { unitDBImage = image }

// OpenDB creates the in-memory database and runs the script, a JSON array of
// SQL statements.
func OpenDB(script []byte) error {
	var stmts []string
	if err := json.Unmarshal(script, &stmts); err != nil {
		return err
	}
	d, err := openSQL(":memory:")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = d.Close()
		}
	}()
	d.SetMaxOpenConns(1)
	for i, st := range stmts {
		if _, execErr := d.Exec(st); execErr != nil {
			err = fmt.Errorf("statement %d: %w: %.200s", i, execErr, st)
			return err
		}
	}
	if err = prepareStore(d); err != nil {
		return err
	}
	previous := db
	db = d
	if previous != nil {
		_ = previous.Close()
	}
	return nil
}

// DBImage copies the current SQLite database into a portable in-memory image.
// The caller owns the returned bytes and may use them for independent sessions.
func DBImage() ([]byte, error) {
	conn, err := DB().Conn(context.Background())
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

// OpenDBImage gives a test class its own connection and writable copy of a
// seeded image. SQLite allocates the image on this connection; later writes
// cannot affect the bytes held by the runner or another class's connection.
func OpenDBImage(image []byte) (err error) {
	d, err := openSQL(":memory:")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = d.Close()
		}
	}()
	d.SetMaxOpenConns(1)
	conn, err := d.Conn(context.Background())
	if err != nil {
		return err
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
		return err
	}
	if err = prepareStore(d); err != nil {
		return err
	}
	previous := db
	db = d
	if previous != nil {
		_ = previous.Close()
	}
	return nil
}

// DB is the process's database; a SELECT before OpenDB is a host error.
func DB() *sql.DB {
	if db == nil {
		if unitDBImage != nil {
			if err := OpenDBImage(unitDBImage); err != nil {
				panic(err)
			}
			BeginUnitLUW()
			return db
		}
		panic(NotCompiled("database", "the host did not open a database"))
	}
	return db
}

// CloseUnitDB releases the current test class's database and its LUW.
// The seed image is kept by the runner, independently of this connection.
func CloseUnitDB() {
	if db == nil {
		return
	}
	if tx != nil {
		end(false)
	}
	stmtCacheFor(nil)
	d := db
	db = nil
	_ = d.Close()
}

// ScriptImage runs a seed script (a JSON array of SQL statements) on an
// in-memory database of its own and returns that database's image. The
// process's database is not touched: a host that serves requests builds the
// image its ABAP Unit runs copy without closing the database it serves.
func ScriptImage(script []byte) (image []byte, err error) {
	var stmts []string
	if err := json.Unmarshal(script, &stmts); err != nil {
		return nil, err
	}
	d, err := openSQL(":memory:")
	if err != nil {
		return nil, err
	}
	defer d.Close()
	d.SetMaxOpenConns(1)
	for i, st := range stmts {
		if _, err := d.Exec(st); err != nil {
			return nil, fmt.Errorf("statement %d: %w: %.200s", i, err, st)
		}
	}
	conn, err := d.Conn(context.Background())
	if err != nil {
		return nil, err
	}
	defer conn.Close()
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

// IsolateDB puts the process's database and the transaction open on it
// aside, and opens a writable copy of image in their place with a unit LUW
// (BeginUnitLUW), so a test class run in a serving process writes, commits
// and rolls back only its copy. restore closes the copy and puts the
// database and its transaction back; it must run before the step that was
// put aside goes on. The caller holds the work process for the whole time.
func IsolateDB(image []byte) (restore func(), err error) {
	savedDB, savedTx := db, tx
	db, tx = nil, nil
	if err := OpenDBImage(image); err != nil {
		db, tx = savedDB, savedTx
		return nil, err
	}
	BeginUnitLUW()
	return func() {
		CloseUnitDB()
		db, tx = savedDB, savedTx
	}, nil
}
