package main

// idSet is an insertion-ordered set of node ids.
// Re-adding an existing id keeps its position. Removing an id and adding it
// again appends it, matching JavaScript Set delete-then-add.
type idSet struct {
	order []int
	index map[int]int
}

func (s *idSet) len() int {
	return len(s.order)
}

func (s *idSet) add(id int) {
	if s.index == nil {
		s.index = make(map[int]int)
	}
	if _, ok := s.index[id]; ok {
		return
	}
	s.index[id] = len(s.order)
	s.order = append(s.order, id)
}

func (s *idSet) remove(id int) {
	if s.index == nil {
		return
	}
	i, ok := s.index[id]
	if !ok {
		return
	}
	delete(s.index, id)
	s.order = append(s.order[:i], s.order[i+1:]...)
	for j := i; j < len(s.order); j++ {
		s.index[s.order[j]] = j
	}
}

func (s *idSet) clear() {
	s.order = s.order[:0]
	clear(s.index)
}

func (s *idSet) snapshot() []int {
	if len(s.order) == 0 {
		return nil
	}
	out := make([]int, len(s.order))
	copy(out, s.order)
	return out
}
