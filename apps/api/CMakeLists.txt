cmake_minimum_required(VERSION 3.25)
project(vote_machine_api LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

find_package(Drogon CONFIG REQUIRED)
include(CTest)
if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
endif()

# Config lib
add_library(vote_machine_config src/config.cpp)
target_include_directories(vote_machine_config PUBLIC src)
target_compile_options(
  vote_machine_config
  PRIVATE -Wall -Wextra -Wpedantic -Werror
)

# API
add_executable(vote_machine_api src/main.cpp)
target_link_libraries(
  vote_machine_api
  PRIVATE vote_machine_config Drogon::Drogon
)
target_compile_options(
  vote_machine_api
  PRIVATE -Wall -Wextra -Wpedantic -Werror
)

# Testing
if(BUILD_TESTING)
  add_executable(config_test tests/config_test.cpp)
  target_link_libraries(
    config_test
    PRIVATE vote_machine_config GTest::gtest_main
  )
  target_compile_options(
    config_test
    PRIVATE -Wall -Wextra -Wpedantic -Werror
  )
  add_test(NAME config_test COMMAND config_test)
endif()
