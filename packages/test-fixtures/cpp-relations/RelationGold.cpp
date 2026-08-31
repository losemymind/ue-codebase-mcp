#include "RelationGold.h"

int RelationGold::Helper(int Value) {
  return Value + 1;
}

int RelationGold::Base::Compute(int Value) const {
  return Value;
}

int RelationGold::Derived::Compute(int Value) const {
  return Helper(Value);
}

int RelationGold::Derived::Run(int Value) const {
  return Compute(Value) + Helper(Count);
}
