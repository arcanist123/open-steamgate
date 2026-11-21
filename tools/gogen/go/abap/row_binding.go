package abap

import (
	"reflect"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"
	"weak"
)

// Weak keys let a table header and its version cell die together. No map value
// retains the table. A binding retains its own table while it is in scope.
var tableVersions sync.Map // weak.Pointer[byte] -> *atomic.Uint64

type versionCacheEntry struct {
	key  uintptr
	w    weak.Pointer[byte]
	cell *atomic.Uint64 // nil means no binding existed at gen
	gen  uint64
}

const versionCacheSize = 256
const versionBloomBits = 1 << 16

var versionCache [versionCacheSize]atomic.Pointer[versionCacheEntry]

// Bits are never cleared: address reuse can only cause a false positive, which
// takes the weak-pointer-validated cache/slow path.
var versionBloom [versionBloomBits / 64]atomic.Uint64
var versionGeneration atomic.Uint64
var versionCreateMu sync.Mutex

func versionBloomHashes(ptr *byte) (uint64, uint64) {
	addr := uint64(uintptr(unsafe.Pointer(ptr))) >> 3
	h1 := addr ^ addr>>17 ^ addr>>31
	h2 := addr * 0x9e3779b97f4a7c15
	h2 ^= h2 >> 32
	return h1 & (versionBloomBits - 1), h2 & (versionBloomBits - 1)
}

func versionBloomSeen(ptr *byte) bool {
	h1, h2 := versionBloomHashes(ptr)
	return versionBloom[h1>>6].Load()&(uint64(1)<<(h1&63)) != 0 &&
		versionBloom[h2>>6].Load()&(uint64(1)<<(h2&63)) != 0
}

func versionBloomAdd(ptr *byte) {
	h1, h2 := versionBloomHashes(ptr)
	versionBloom[h1>>6].Or(uint64(1) << (h1 & 63))
	versionBloom[h2>>6].Or(uint64(1) << (h2 & 63))
}

func versionSlot(ptr *byte) *atomic.Pointer[versionCacheEntry] {
	key := uintptr(unsafe.Pointer(ptr))
	// Table headers are aligned; mix the high bits into the slot index.
	key ^= key >> 11
	key ^= key >> 21
	return &versionCache[key&(versionCacheSize-1)]
}

func cachedVersion(ptr *byte) (*atomic.Uint64, bool) {
	e := versionSlot(ptr).Load()
	if e == nil || e.key != uintptr(unsafe.Pointer(ptr)) || e.w.Value() != ptr {
		return nil, false
	}
	if e.cell == nil {
		gen := versionGeneration.Load()
		if gen&1 != 0 || e.gen != gen {
			return nil, false
		}
	}
	return e.cell, true
}

func cacheVersion(ptr *byte, w weak.Pointer[byte], cell *atomic.Uint64, gen uint64) {
	versionSlot(ptr).Store(&versionCacheEntry{key: uintptr(unsafe.Pointer(ptr)), w: w, cell: cell, gen: gen})
}

func versionCell(table any) *atomic.Uint64 {
	ptr := (*byte)(reflect.ValueOf(table).UnsafePointer())
	if cell, ok := cachedVersion(ptr); ok && cell != nil {
		runtime.KeepAlive(table)
		return cell
	}
	key := weak.Make(ptr)
	if v, ok := tableVersions.Load(key); ok {
		cell := v.(*atomic.Uint64)
		cacheVersion(ptr, key, cell, 0)
		runtime.KeepAlive(table)
		return cell
	}
	versionCreateMu.Lock()
	if v, ok := tableVersions.Load(key); ok {
		versionCreateMu.Unlock()
		cell := v.(*atomic.Uint64)
		cacheVersion(ptr, key, cell, 0)
		runtime.KeepAlive(table)
		return cell
	}
	// Odd generations reject negative hits while the cell is being published.
	// Publish both Bloom bits first, so a later BumpTable cannot miss this cell.
	versionBloomAdd(ptr)
	versionGeneration.Add(1)
	cell := new(atomic.Uint64)
	tableVersions.Store(key, cell)
	versionGeneration.Add(1)
	versionCreateMu.Unlock()
	runtime.AddCleanup(ptr, func(k weak.Pointer[byte]) { tableVersions.Delete(k) }, key)
	cacheVersion(ptr, key, cell, 0)
	runtime.KeepAlive(table)
	return cell
}

func tableVersion(table any) uint64 { return versionCell(table).Load() }

func BumpTable(table any) {
	ptr := (*byte)(reflect.ValueOf(table).UnsafePointer())
	if !versionBloomSeen(ptr) {
		runtime.KeepAlive(table)
		return
	}
	if cell, ok := cachedVersion(ptr); ok {
		if cell != nil {
			cell.Add(1)
		}
		runtime.KeepAlive(table)
		return
	}
	key := weak.Make(ptr)
	for {
		gen := versionGeneration.Load()
		if gen&1 != 0 {
			continue
		}
		if v, ok := tableVersions.Load(key); ok {
			cell := v.(*atomic.Uint64)
			cacheVersion(ptr, key, cell, 0)
			cell.Add(1)
			break
		}
		if gen == versionGeneration.Load() {
			cacheVersion(ptr, key, nil, gen)
			break
		}
	}
	runtime.KeepAlive(table)
}

// RowBinding owns its validation token; binding another symbol to the same
// slice slot cannot change this one. Access needs no global map lookup.
type RowBinding[T any] struct {
	row     *T
	table   *[]T
	version *atomic.Uint64
	at      uint64
	index   int
}

func BindRow[T any](table *[]T, index int) *RowBinding[T] {
	cell := versionCell(table)
	return &RowBinding[T]{row: &(*table)[index], table: table, version: cell, at: cell.Load(), index: index}
}

func DirectBinding[T any](row *T) *RowBinding[T] { return &RowBinding[T]{row: row} }

func CheckedRowPtr[T any](b *RowBinding[T]) *T {
	if b == nil || b.row == nil {
		panic(ArithmeticError{Class: "GETWA_NOT_ASSIGNED", Op: "unassigned field symbol"})
	}
	if b.table != nil && (b.version.Load() != b.at || b.index >= len(*b.table) || &(*b.table)[b.index] != b.row) {
		panic(ArithmeticError{Class: "GETWA_NOT_ASSIGNED", Op: "table row binding after structural mutation"})
	}
	return b.row
}
