//go:build !wasm && !nodatabase

package abap

import (
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"testing"

	"osg/gogen/session"
)

const imageSeed = `["CREATE TABLE unit_image (id INTEGER PRIMARY KEY AUTOINCREMENT, MANDT TEXT, value TEXT)","CREATE INDEX unit_image_client ON unit_image (MANDT, value)","CREATE VIEW unit_image_123 AS SELECT id, value FROM unit_image WHERE MANDT = '123'","INSERT INTO unit_image (MANDT, value) VALUES ('123', 'first')","INSERT INTO unit_image (MANDT, value) VALUES ('456', 'other client')","DELETE FROM unit_image WHERE id = 2","INSERT INTO unit_image (MANDT, value) VALUES ('456', 'later')"]`

func seedImage(t *testing.T) []byte {
	t.Helper()
	d, err := OpenDB([]byte(imageSeed))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	image, err := d.Image()
	if err != nil {
		t.Fatal(err)
	}
	return image
}

type imageState struct {
	Schema    [][4]string
	Counts    map[string]int
	Checksums map[string][32]byte
}

// Compare sqlite_master and every table, including sqlite_sequence. Sorting
// encoded rows gives a stable checksum independent of query iteration order.
func snapshotImage(t *testing.T, d *Database) imageState {
	t.Helper()
	state := imageState{Counts: map[string]int{}, Checksums: map[string][32]byte{}}
	rows, err := d.SQL().Query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for rows.Next() {
		var typ, name, table string
		var statement sql.NullString
		if err := rows.Scan(&typ, &name, &table, &statement); err != nil {
			t.Fatal(err)
		}
		state.Schema = append(state.Schema, [4]string{typ, name, table, statement.String})
		if typ == "table" {
			tables = append(tables, name)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	for _, table := range tables {
		rows, err := d.SQL().Query(`SELECT * FROM "` + table + `"`)
		if err != nil {
			t.Fatal(err)
		}
		columns, err := rows.Columns()
		if err != nil {
			t.Fatal(err)
		}
		var encoded []string
		for rows.Next() {
			values := make([]any, len(columns))
			addresses := make([]any, len(values))
			for i := range values {
				addresses[i] = &values[i]
			}
			if err := rows.Scan(addresses...); err != nil {
				t.Fatal(err)
			}
			b, err := json.Marshal(values)
			if err != nil {
				t.Fatal(err)
			}
			encoded = append(encoded, string(b))
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		sort.Strings(encoded)
		state.Counts[table] = len(encoded)
		state.Checksums[table] = sha256.Sum256([]byte(fmt.Sprint(encoded)))
	}
	return state
}

func TestDBImageMatchesFreshSeed(t *testing.T) {
	image := seedImage(t)
	fresh, err := OpenDB([]byte(imageSeed))
	if err != nil {
		t.Fatal(err)
	}
	want := snapshotImage(t, fresh)
	fresh.Close()
	copy, err := OpenDBImage(image)
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	got := snapshotImage(t, copy)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("image differs from fresh seed:\n got %#v\nwant %#v", got, want)
	}
}

func TestUnitImageClassBoundary(t *testing.T) {
	image := seedImage(t)
	for _, finish := range []string{"commit", "rollback"} {
		t.Run(finish, func(t *testing.T) {
			session.BeginTestClass()
			first := &Session{}
			if err := first.OpenUnitDB(image); err != nil {
				t.Fatal(err)
			}
			if _, err := first.conn().Exec("INSERT INTO unit_image (MANDT, value) VALUES ('123', 'first class')"); err != nil {
				t.Fatal(err)
			}
			if finish == "commit" {
				CommitWork(first)
			} else {
				RollbackWork(first)
			}
			EndTestClass(first)
			if first.DB != nil || first.tx != nil {
				t.Fatal("first class retained DB or LUW")
			}

			session.BeginTestClass()
			none := &Session{}
			EndTestClass(none) // class without SQL
			if none.DB != nil || none.tx != nil {
				t.Fatal("non-DB class retained DB or LUW")
			}

			session.BeginTestClass()
			second := &Session{}
			if err := second.OpenUnitDB(image); err != nil {
				t.Fatal(err)
			}
			var count int
			if err := second.tx.QueryRow("SELECT count(*) FROM unit_image WHERE value = 'first class'").Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatalf("second class sees %d writes from first", count)
			}
			EndTestClass(second)
		})
	}
}

func TestUnitImageCopiesDoNotAccumulate(t *testing.T) {
	image := seedImage(t)
	for i := 0; i < 40; i++ {
		session.BeginTestClass()
		s := &Session{}
		if err := s.OpenUnitDB(image); err != nil {
			t.Fatal(err)
		}
		copy := s.DB.SQL()
		if _, err := s.conn().Exec("INSERT INTO unit_image (MANDT, value) VALUES ('123', 'temporary')"); err != nil {
			t.Fatal(err)
		}
		EndTestClass(s)
		if s.DB != nil || s.tx != nil || copy.Stats().OpenConnections != 0 {
			t.Fatalf("class %d retained DB copy or LUW: %+v", i, copy.Stats())
		}
	}
}

func TestUnitImageOpensOnDynamicSQL(t *testing.T) {
	image := seedImage(t)
	session.BeginTestClass()
	first := &Session{}
	first.UseUnitImage(image)
	// The runner's static SQL detection can miss a dynamically called method.
	// Its first statement still needs the private image and an active LUW.
	if _, err := first.conn().Exec("INSERT INTO unit_image (MANDT, value) VALUES ('123', 'dynamic')"); err != nil {
		t.Fatal(err)
	}
	if first.tx == nil {
		t.Fatal("dynamic SQL did not begin a Unit LUW")
	}
	RollbackWork(first)
	EndTestClass(first)
	if first.DB != nil {
		t.Fatal("class kept its DB copy")
	}
	session.BeginTestClass()
	none := &Session{}
	none.UseUnitImage(image)
	EndTestClass(none)
	if none.DB != nil {
		t.Fatal("class without SQL opened a DB copy")
	}
	session.BeginTestClass()
	second := &Session{}
	second.UseUnitImage(image)
	t.Cleanup(func() { EndTestClass(second) })
	var count int
	rows, err := second.conn().Query("SELECT count(*) FROM unit_image WHERE value = 'dynamic'")
	if err != nil {
		t.Fatal(err)
	}
	if !rows.Next() || rows.Scan(&count) != nil {
		t.Fatal("cannot count dynamic writes")
	}
	rows.Close()
	if count != 0 {
		t.Fatalf("second class sees %d writes", count)
	}
}
