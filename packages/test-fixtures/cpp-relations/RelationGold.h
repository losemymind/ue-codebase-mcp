#pragma once

#include "RelationDependency.h"

namespace RelationGold {

class Base {
public:
  virtual int Compute(int Value) const;
};

class Derived final : public Base {
public:
  int Compute(int Value) const override;
  int Run(int Value) const;

private:
  int Count = 1;
};

} // namespace RelationGold
